# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-09-18

### Added

- Multi-channel approver: approval requests are routed to a per-team Google Chat space based on the
  requester's Keeper team membership, resolved through Commander `list-team`. Disabled by default.
  Configured with `multichannel_approver` in `config.yaml`, or with `multi_channel_approvers_enabled`
  and `approvals_teams` on the KSM `GCHAT_RECORD` for Docker deployments. Team names must match the
  Keeper team name exactly. When the feature is off, or the requester belongs to no mapped team, the
  request goes to the default approvals space as before.
- Optional approver boundaries: `allowed_folder_uids` and `allowed_record_uids` on a team limit what an
  approver searching from that team's space can find. Teams configured without either list stay
  unrestricted (routing only).
- No-argument request forms: `/keeper-request-record`, `/keeper-request-folder`,
  `/keeper-external-share`, and `/keeper-create-secret` now open a form card when invoked with no
  arguments, instead of returning a usage error.

### Changed

- The record, folder, and external-share request handlers now share a single request path.

### Security

- Updated `js-yaml` to 4.3.2.

## [1.0.0] - 2026-08-27

Initial release.

### Added

- Google Chat app for Keeper approval workflows, delivered over Cloud Pub/Sub so no inbound
  HTTP endpoint is required.
- Slash commands: `/keeper-request-record`, `/keeper-request-folder`, `/keeper-external-share`,
  and `/keeper-create-secret`.
- Approval cards in a dedicated Google Chat space, with record search, permission and duration
  selection, and direct-message notifications to the requester.
- Optional Endpoint Privilege Manager elevation approvals via background polling.
- Optional Cloud SSO device approvals via background polling.
- Configuration from `config.yaml` for local use, or from Keeper Secrets Manager in production.
- Multi-architecture container image published to `keeper/gchat-app` for `linux/amd64` and
  `linux/arm64`.

[1.1.0]: https://github.com/Keeper-Security/google-chat-integration/releases/tag/v1.1.0
[1.0.0]: https://github.com/Keeper-Security/google-chat-integration/releases/tag/v1.0.0
