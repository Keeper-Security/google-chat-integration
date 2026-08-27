# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.0.0]: https://github.com/Keeper-Security/google-chat-integration/releases/tag/v1.0.0
