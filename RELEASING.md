# Releasing

The Docker image is published to `keeper/gchat-app` on DockerHub for `linux/amd64` and
`linux/arm64`.

Keeper Commander's `gchat-app-setup` command generates customer compose files that reference
`keeper/gchat-app:latest`, so `:latest` is only ever moved to a tag that has been verified in a
real deployment.

## Workflows

| Workflow | Trigger | Publishes |
|----------|---------|-----------|
| `ci.yml` | Pull requests, pushes to `main` | Nothing. Builds both architectures and runs a smoke test. |
| `docker-release.yml` | Push of a `v*` tag | `:vX.Y.Z` and `:<short-sha>` |
| `docker-promote-latest.yml` | Manual | `:latest` |

Publishing happens only in CI. There is no local push path, because the image is multi-arch.

## Requirements

A GitHub environment named `release` holding `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` as
environment secrets. The token needs read and write access to `keeper/gchat-app`.

## Steps

1. Set `version` in `package.json` and merge to `main`. The release workflow rejects a tag that
   does not match this value.

2. Publish a release candidate:

   ```bash
   task tag-rc RC=1
   ```

   This pushes `vX.Y.Z-rc.N`, which publishes the RC tag and leaves `:latest` untouched.

3. Verify the release candidate end to end:

   - Run `gchat-app-setup` in Commander, then edit the generated `docker-compose.yml` to
     reference the RC tag instead of `:latest`.
   - `docker compose up -d`
   - `docker logs keeper-service` shows Commander healthy.
   - `docker logs keeper-gchat-app` shows `GOOGLE CHAT SERVER STARTED` and
     `KEEPER SERVICE MODE ACCESSIBLE`. The second banner confirms the app resolved the
     Commander service over the compose network.
   - No warning about the `server` command being unavailable. Without it, vault deep links
     fall back to a default domain.
   - In Google Chat, run `/keeper-request-record "AWS test" need staging access`. An approval
     card appears in the approvals space. **Search Records** exercises the `CARD_CLICKED`
     Pub/Sub path; selecting a record and approving updates the card and sends the requester a
     direct message.

4. Publish the release:

   ```bash
   task tag
   ```

5. Promote `:latest` to the verified tag:

   ```bash
   task promote TAG=vX.Y.Z
   ```

   This copies the published manifest by digest rather than rebuilding, so `:latest` resolves
   to the same image that was verified in step 3.

6. Confirm an unauthenticated pull works, since customers pull anonymously:

   ```bash
   docker logout
   docker pull keeper/gchat-app:latest
   ```

7. Add the release to `CHANGELOG.md`.

## Notes

- Version tags are immutable. The release workflow fails if the tag already exists on
  DockerHub; bump the version instead of moving a tag.
- A tag must be an ancestor of `main` to release.
- `:latest` cannot be moved backwards, and cannot be pointed at a prerelease.
