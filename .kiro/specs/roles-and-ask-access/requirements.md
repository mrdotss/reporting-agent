# Requirements — Roles and Ask access

## Introduction

This spec covers five changes:

- Workspace roles become one explicit matrix.
- Only the owner changes the team or the close day.
- Ask becomes available only to accounts a platform admin grants it to, plus the members of that admin's own workspaces.
- Two reported defects are fixed:
  - the sign-up form read as demanding hundreds of characters;
  - an accepted invitation did not land on the dashboard.

Roles are held per workspace. Every account owns its own workspace, so every rule below applies inside one workspace and never across two.

## Glossary

- **Workspace role:** Owner, Admin, Editor or Viewer, held by a member of one workspace.
- **Platform admin:** an account whose email is listed in `RPT_PLATFORM_ADMIN_EMAILS`.
- **Ask home:** a workspace whose owner is a platform admin.
- **Ask grant:** an `ask_access` row for an account, written only by a platform admin.

## Requirement 1 — The role matrix

1. Every member SHALL read their workspace's dashboard, reports, presets and connectors.
2. Owner, Admin and Editor SHALL create and edit presets and request reports. A Viewer SHALL NOT.
3. Workspace settings SHALL be not found for a Viewer. Tabs SHALL be shown by role:
   - an Editor SHALL see Customers only;
   - an Admin SHALL also see Members and Close, both read-only.

## Requirement 2 — Only the owner changes the team

1. Only the Owner SHALL create or revoke invitations, change a member's role, or remove a member. The server SHALL refuse anyone else.
2. No one SHALL become or stop being the Owner except through an ownership transfer.

## Requirement 3 — Only the owner moves the close day

1. Only the Owner SHALL change the close day. An Admin SHALL see it read-only.

## Requirement 4 — Customers

1. Owner, Admin and Editor SHALL add, rename, archive and restore customers. A Viewer SHALL NOT.

## Requirement 5 — Connectors

1. Owner and Admin SHALL add, rotate, disable and scan connectors.
2. Editor and Viewer SHALL see connectors and their latest scan without those controls.
3. `/subscriptions/new` SHALL be not found for Editor and Viewer, and the connector routes SHALL refuse both.

## Requirement 6 — Ask access

1. Ask SHALL be available to a member of a workspace in exactly these cases:
   - **Ask home:** the workspace is an Ask home and the member holds no Ask grant. Owner, Admin and Editor get chat; a Viewer gets read.
   - **Granted owner:** the member holds an Ask grant and owns the workspace. They get chat.
2. Everywhere else Ask SHALL be unavailable:
   - absent from the navigation and the command menu;
   - `/ask` not found;
   - every chat route answering 404.

   In particular:
   - a granted account SHALL NOT see an Ask home's conversations, even as its member;
   - the people a granted account invites SHALL NOT get Ask in its workspace.
3. At read level, a member SHALL list and open conversations. They SHALL NOT:
   - create a conversation;
   - send a message;
   - change attachments or rename a conversation;
   - collect live metrics;
   - act on a proposal.
4. With `RPT_PLATFORM_ADMIN_EMAILS` unset, Ask SHALL be unavailable to everyone.

## Requirement 7 — The admin page

1. `/admin` SHALL be not found for anyone who is not a platform admin. The route that changes a grant SHALL answer 404 to them and refuse cross-site requests.
2. The page SHALL list accounts with:
   - email;
   - when they joined;
   - how many workspaces they own;
   - their role in the admin's workspaces;
   - whether and when they were granted Ask.
3. A platform admin SHALL grant or remove Ask for any account that is not itself a platform admin. A grant SHALL record who granted it and when.

## Requirement 8 — Sign-up validation

1. The form SHALL state what a person has to meet: a valid email, and at least 12 characters. It SHALL NOT print a maximum length beside an input.
2. A rejected email or password SHALL be shown on that field, naming the bound it broke.
3. "That email address is not available." SHALL remain one message, about no field.
4. The typed email SHALL survive a rejection. The browser's own validation SHALL NOT answer before the server's message.

## Requirement 9 — Invitations

1. A signed-in visitor who accepts SHALL land on the dashboard of the workspace they joined.
2. A signed-out visitor who presses Accept SHALL be joined without pressing again:
   - after signing in;
   - after creating an account instead, once the app returns them to finish.
3. An invitation that cannot be accepted SHALL say so, and SHALL NOT be resumed again.

## Requirement 10 — Workspace name

1. The Owner SHALL rename a workspace, including the default workspace every account is given. The name SHALL be trimmed and 1–120 characters long.
2. No other role SHALL rename a workspace. The server SHALL refuse them, and Workspace settings SHALL offer the control to the Owner only.
3. A rename SHALL be recorded in the workspace's audit log, and every member SHALL see the new name.
