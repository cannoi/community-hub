# Community Hub — SoloHost install kit

Use the two install files:
- docker-compose.yml
- config_options.yml

Suggested name: Community Hub
Suggested description: Self-hosted community & federated social network (EN/VI) with groups, posts, media and an optional AI assistant.

Image:
paf-app:community-hub

Data persists in the `hub-data` volume (database, identity keys, uploads). Optional settings (all have safe defaults) are listed in `docs/DEPLOYMENT.md`.

If something fails, paste the SoloHost error back into App Builder. It will use the saved project context to diagnose and repair the release.
