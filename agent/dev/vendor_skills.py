"""Vendor the curated agent skills into `src/reporting_agent/skills/vendor/`.

Run from `agent/`:  python dev/vendor_skills.py

Downloads each source repository at the **pinned** commit below and copies only the
curated skills' Markdown — never their scripts, templates or assets, which the runtime has
no use for and would not run. Each source's licence is copied beside its skills, and
`vendor/SOURCES.json` records exactly what was taken from where, so a refresh is a reviewed
diff: bump a commit, rerun, read the change.

Why vendored rather than fetched at run time: the image is proven at build time, and a
skill that changed under a running deployment would change what Ask is told without a
review, a test or a new image.
"""

from __future__ import annotations

import io
import json
import shutil
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "src" / "reporting_agent" / "skills" / "vendor"

SOURCES: dict[str, dict[str, object]] = {
    "style": {
        "repository": "petergyang/no-ai-slop",
        "commit": "000650b156983f5159695b441477f4e63b25dc85",
        "licence": "MIT",
        "licence_file": "LICENSE",
        "skills": {"no-ai-slop": "skills/no-ai-slop"},
    },
    "azure": {
        "repository": "MicrosoftDocs/Agent-Skills",
        "commit": "1e593dd0d55091fb66568c9194b29d8155453977",
        "licence": "CC-BY-4.0",
        "licence_file": "LICENSE",
        "skills": {
            name: f"skills/{name}"
            for name in (
                "azure-virtual-machines",
                "azure-vm-scalesets",
                "azure-virtual-network",
                "azure-networking",
                "azure-load-balancer",
                "azure-application-gateway",
                "azure-nat-gateway",
                "azure-network-watcher",
                "azure-firewall",
                "azure-bastion",
                "azure-dns",
                "azure-vpn-gateway",
                "azure-blob-storage",
                "azure-files",
                "azure-database-postgresql",
                "azure-database-mysql",
                "azure-sql-database",
                "azure-cosmos-db",
                "azure-cache-redis",
                "azure-app-service",
                "azure-functions",
                "azure-kubernetes-service",
                "azure-container-apps",
                "azure-monitor",
                "azure-advisor",
                "azure-backup",
                "azure-site-recovery",
                "azure-cost-management",
                "azure-quotas",
                "azure-reliability",
                "azure-well-architected",
                "azure-key-vault",
                "azure-defender-for-cloud",
            )
        },
    },
    "aws": {
        "repository": "aws/agent-toolkit-for-aws",
        "commit": "4602726431d1929342fcc50f45d63bfa5ca450f9",
        "licence": "Apache-2.0",
        "licence_file": "LICENSE",
        "skills": {
            path.rsplit("/", 1)[-1]: f"skills/{path}"
            for path in (
                "core-skills/aws-compute",
                "core-skills/aws-billing-and-cost-management",
                "core-skills/aws-storage",
                "core-skills/aws-networking",
                "core-skills/aws-observability",
                "core-skills/aws-database",
                "core-skills/aws-well-architected-review",
                "core-skills/aws-security",
                "core-skills/aws-containers",
                "core-skills/aws-serverless",
                "core-skills/aws-iam",
                "specialized-skills/ec2-skills/launching-ec2-instance-with-best-practices",
                "specialized-skills/database-skills/rds-oss",
                "specialized-skills/database-skills/amazon-aurora-postgresql",
                "specialized-skills/database-skills/amazon-aurora-mysql",
                "specialized-skills/storage-skills/securing-s3-buckets",
                "specialized-skills/operations-skills/setting-up-cloudwatch-alarm-notifications",
            )
        },
    },
}


def _tarball(repository: str, commit: str) -> tarfile.TarFile:
    url = f"https://codeload.github.com/{repository}/tar.gz/{commit}"
    with urllib.request.urlopen(url, timeout=120) as response:
        return tarfile.open(fileobj=io.BytesIO(response.read()), mode="r:gz")


def main() -> int:
    if ROOT.exists():
        shutil.rmtree(ROOT)
    record: dict[str, object] = {}
    for source, spec in SOURCES.items():
        archive = _tarball(str(spec["repository"]), str(spec["commit"]))
        members = {member.name.split("/", 1)[1]: member for member in archive.getmembers() if "/" in member.name}
        target = ROOT / source
        target.mkdir(parents=True)

        licence = members[str(spec["licence_file"])]
        (target / "LICENSE").write_bytes(archive.extractfile(licence).read())  # type: ignore[union-attr]

        copied: dict[str, list[str]] = {}
        for name, prefix in dict(spec["skills"]).items():  # type: ignore[arg-type]
            files = sorted(
                path
                for path, member in members.items()
                if member.isfile() and path.startswith(f"{prefix}/") and path.endswith(".md")
            )
            if f"{prefix}/SKILL.md" not in files:
                print(f"missing {source}/{name}: no SKILL.md under {prefix}", file=sys.stderr)
                return 1
            for path in files:
                destination = target / name / path[len(prefix) + 1 :]
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(archive.extractfile(members[path]).read())  # type: ignore[union-attr]
            copied[name] = [path[len(prefix) + 1 :] for path in files]
        record[source] = {
            "repository": spec["repository"],
            "commit": spec["commit"],
            "licence": spec["licence"],
            "skills": copied,
        }
        print(f"{source}: {len(copied)} skills from {spec['repository']}@{str(spec['commit'])[:7]}")

    (ROOT / "SOURCES.json").write_text(json.dumps(record, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
