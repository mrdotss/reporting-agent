"""A construction log, and stand-ins for the things a collection constructs.

Req 19.3 asks for two facts about one collection: the `ClientSecretCredential` is built
**exactly once**, and it is built **before the first Azure client**. The second half is an
*ordering* claim, so it needs a single place that sees both kinds of construction happen —
otherwise "before" is inferred from reading the code, which is the thing the test exists to
stop trusting.

:class:`ConstructionLog` is that place. The credential factory and every client stand-in
append to the same log, in the order they were constructed, so the assertion is
`log.kinds()[0] == "credential"` — a fact about a recorded sequence rather than a fact about
a call graph. Appends are guarded by a lock because the clients are used from
`asyncio.to_thread` workers, which is how the synchronous Azure SDK clients actually run
inside this runtime.

Nothing here imports an Azure SDK, reaches a network or needs a tenant.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Any, Final

from azure.core.credentials import AccessToken

__all__ = [
    "CLIENT",
    "CREDENTIAL",
    "Construction",
    "ConstructionLog",
    "RecordingAzureClient",
    "RecordingCredentialFactory",
    "RecordingSdkCredential",
]

CREDENTIAL: Final[str] = "credential"
"""A `ClientSecretCredential` construction."""

CLIENT: Final[str] = "client"
"""An Azure client construction — the thing Req 19.3 says must come second."""


@dataclass(frozen=True, slots=True)
class Construction:
    """One recorded construction, with its position in the invocation's sequence."""

    kind: str
    detail: str
    index: int

    def __str__(self) -> str:  # pragma: no cover - assertion-failure readability only
        return f"{self.index}:{self.kind}:{self.detail}"


class ConstructionLog:
    """Every construction in one process, in order, across threads.

    Shared by the credential factory and the client stand-ins deliberately: two separate
    logs could each be correct and still say nothing about which happened first.
    """

    def __init__(self) -> None:
        self._entries: list[Construction] = []
        self._lock = threading.Lock()

    def record(self, kind: str, detail: str) -> Construction:
        with self._lock:
            entry = Construction(kind=kind, detail=detail, index=len(self._entries))
            self._entries.append(entry)
            return entry

    @property
    def entries(self) -> tuple[Construction, ...]:
        with self._lock:
            return tuple(self._entries)

    def kinds(self) -> tuple[str, ...]:
        return tuple(entry.kind for entry in self.entries)

    def of(self, kind: str) -> tuple[Construction, ...]:
        return tuple(entry for entry in self.entries if entry.kind == kind)

    def count(self, kind: str) -> int:
        return len(self.of(kind))

    def first_index(self, kind: str) -> int:
        """The position of the first `kind`, or `-1` if it never happened.

        `-1` rather than an exception so a failing ordering assertion reports the whole
        recorded sequence instead of raising from inside the assertion itself.
        """
        matches = self.of(kind)
        return matches[0].index if matches else -1

    def __repr__(self) -> str:  # pragma: no cover - assertion-failure readability only
        return f"ConstructionLog({[str(entry) for entry in self.entries]})"


class RecordingSdkCredential:
    """Stands in for `ClientSecretCredential`. Constructs nothing, calls nothing.

    Tokens are tagged with this instance's own sequence number, which is what makes
    Req 19.4 checkable: a token issued by invocation 1 is textually distinguishable from
    one issued by invocation 2, so "shares no cached token" is an assertion about values
    rather than about object identity.
    """

    def __init__(
        self,
        *,
        tenant_id: str,
        client_id: str,
        client_secret: str,
        sequence: int,
        error: BaseException | None = None,
        lifetime: int = 3600,
    ) -> None:
        self.tenant_id = tenant_id
        self.client_id = client_id
        self.client_secret = client_secret
        self.sequence = sequence
        self.error = error
        self.lifetime = lifetime
        self.scopes: list[str] = []
        self.closed = False
        self._lock = threading.Lock()

    def get_token(self, *scopes: str, **_: Any) -> AccessToken:
        scope = scopes[0]
        with self._lock:
            self.scopes.append(scope)
        if self.error is not None:
            raise self.error
        return AccessToken(
            f"token:invocation-{self.sequence}:{scope}", int(time.time()) + self.lifetime
        )

    def close(self) -> None:
        self.closed = True


@dataclass
class RecordingCredentialFactory:
    """A `CredentialFactory` that records every construction into a shared log.

    Passed to `InvocationCredential(..., credential_factory=...)`, which is the seam
    `azure/credential.py` declares for exactly this: counting constructions without a
    tenant.
    """

    log: ConstructionLog
    error: BaseException | None = None
    built: list[RecordingSdkCredential] = field(default_factory=list)

    def __call__(
        self, *, tenant_id: str, client_id: str, client_secret: str, **_: Any
    ) -> RecordingSdkCredential:
        self.log.record(CREDENTIAL, tenant_id)
        credential = RecordingSdkCredential(
            tenant_id=tenant_id,
            client_id=client_id,
            client_secret=client_secret,
            sequence=len(self.built) + 1,
            error=self.error,
        )
        self.built.append(credential)
        return credential


class RecordingAzureClient:
    """Stands in for one Azure client — a batch metrics client, a Resource Graph client.

    Takes a `TokenCredential` the way every Azure SDK client does, records its own
    construction into the shared log, and calls `get_token` **synchronously** from
    :meth:`request`, because that is what a sync SDK client's auth policy does on whichever
    thread the request runs on.
    """

    def __init__(
        self,
        *,
        credential: Any,
        scope: str,
        log: ConstructionLog,
        kind: str,
        location: str = "",
        resource_type: str = "",
    ) -> None:
        self.credential = credential
        self.scope = scope
        self.kind = kind
        self.location = location
        self.resource_type = resource_type
        self.tokens: list[str] = []
        self.closed = False
        self._lock = threading.Lock()
        self.construction = log.record(
            CLIENT, ":".join(part for part in (kind, location, resource_type) if part)
        )

    def request(self) -> str:
        """One request, authenticated the way the SDK authenticates: `get_token` inline."""
        token = self.credential.get_token(self.scope)
        with self._lock:
            self.tokens.append(token.token)
        return token.token

    def close(self) -> None:
        self.closed = True

    def __repr__(self) -> str:  # pragma: no cover - assertion-failure readability only
        return (
            f"RecordingAzureClient(kind={self.kind!r}, location={self.location!r}, "
            f"resource_type={self.resource_type!r})"
        )
