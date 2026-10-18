# Vendored theme faces

The `ledger`, `signal` and `brief` themes name faces that no Amazon Linux package carries.
They live here, and the Dockerfile copies them to `/usr/share/fonts/reporting-agent/`,
checks them against `SHA256SUMS` and refreshes the font cache. After that,
`python -m reporting_agent.render.themes --assert-fonts` fails the build if any face a theme
names does not resolve to itself.

Each family is taken from its foundry's own repository at a pinned commit, as static TTFs.
All of them are licensed under the SIL Open Font License 1.1, and each licence travels with
its files.

| Files | Source | Commit | Licence |
|---|---|---|---|
| `IBMPlexSans-{Regular,Italic,SemiBold,Bold}.ttf`, `IBMPlexMono-{Regular,Medium,Bold}.ttf` | `github.com/IBM/plex`, `packages/plex-{sans,mono}/fonts/complete/ttf/` | `71f558992315a12ca1f06a2215d57962a1992162` | `OFL-IBMPlex.txt` |
| `Archivo-{Regular,Bold,ExtraBold,Black}.ttf` | `github.com/Omnibus-Type/Archivo`, `fonts/ttf/` | `211127690e8ff106c36c935f7e5e697114cff103` | `OFL-Archivo.txt` |
| `SourceSerif4-{Regular,Semibold,Bold}.ttf` | `github.com/adobe-fonts/source-serif`, `TTF/` | `80d3f8894c09c937bebfa9011247d2e1c79fd6f4` | `OFL-SourceSerif4.txt` (upstream `LICENSE.md`) |
| `SourceSans3-{Regular,It,Semibold,Bold}.ttf` | `github.com/adobe-fonts/source-sans`, `TTF/` | `87b37a2daaed80fcb8e8ccb0085c4d72ddade12e` | `OFL-SourceSans3.txt` (upstream `LICENSE.md`) |

The Adobe licences are renamed from `.md` to `.txt` because `.dockerignore` drops every
`*.md`. A licence that never reached the image would also fail its own checksum line.

## Adding or changing a face

1. Fetch the file from the foundry's repository at a commit, and record the commit above.
2. Run `sha256sum *.ttf OFL-*.txt > SHA256SUMS` here.
3. Name the face in `THEME_SPECS`, then regenerate the themes and their thumbnails (see
   `../THEMES.md`).

`tests/test_image_build.py` checks that the checksums match the files, that every face a
theme names is supplied by a package or by a file here (read from the file's own name
table), and that the Dockerfile installs and asserts these faces.

To render locally with these faces without installing them system-wide, point fontconfig
at a configuration that includes this directory:

```xml
<fontconfig>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>/absolute/path/to/agent/fonts</dir>
</fontconfig>
```

Then set `FONTCONFIG_FILE` to that file for the command.
