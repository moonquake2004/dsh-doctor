# Security Policy

`dsh-doctor` is a diagnostics tool for DeepSeek Harness, and it embeds the `dsh-security` check
framework via `--security`.

**Reporting a vulnerability:** GitHub private vulnerability reporting is enabled on this repository —
<https://github.com/moonquake2004/dsh-doctor/security/advisories/new>. If you cannot use it, open a
content-free public issue asking for a security contact and we will move to a private channel; please
do not describe the issue in public.

The full policy — scope, what counts as a vulnerability here (including **false negatives**, where a
check silently stops matching after a format change, and **false positives** severe enough that
operators stop trusting the tool), and our own coordination practice — is maintained in
[`dsh-security/SECURITY.md`](https://github.com/moonquake2004/dsh-security/blob/main/SECURITY.md) and
applies to this repository as well.

Out of scope here but relayed to the right maintainer: issues in the DSH host itself or in third-party
plugins.
