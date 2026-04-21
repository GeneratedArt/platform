# templates/

Source of truth for repo templates the GeneratedArt platform clones into the
org. The contents of `art-template/` should be force-pushed to
`GeneratedArt/art-template` whenever they change — that's the repo the
GitHub App uses as the seed for every new `art-<slug>` project.

| Directory | Org repo | Purpose |
|-----------|----------|---------|
| `art-template/` | [`GeneratedArt/art-template`](https://github.com/GeneratedArt/art-template) | Per-project starter (HTML, $ga SDK, validate + release workflows) |
