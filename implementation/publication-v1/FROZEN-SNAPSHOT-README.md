# Frozen WordPress snapshot read-back

This slice exposes the exact, owner-bound snapshot already frozen by `prepare`; it does not create an operation, render a replacement, approve, or publish.

## WordPress contract

`GET /wp-json/publication-v1/v1/operations/{32-hex-operation-id}/snapshot` requires `publish_publication_v1`. It returns exactly:

```json
{"id":"…","digest":"…","state":"pending","snapshot_json":"…"}
```

The lookup is publisher-owner scoped and is available only while the operation is unexpired and `pending` or `approved`, its snapshot is current, and its package remains owned by the same publisher and site. Other owners receive not-found; users without publisher capability, including reviewers and anonymous users, are denied. Responses are `private, no-store`.

`snapshot_json` is the original snapshot encoded with `pubv1_canonical_json`. The operation digest is SHA-256 of those exact UTF-8 bytes. The endpoint fails closed if the rendered value is not a string or `wp_kses_post(rendered) !== rendered`; it never sanitizes or rewrites stored content. This preserves the equality between the final returned `rendered` bytes and the reviewer page's `wp_kses_post(snapshot.rendered)` output.

## Authenticated local bridge

`GET /v1/frozen/{operation-id}` uses the existing exact `Origin: app://obsidian.md`, pinned `Host`, and startup Bearer checks. A successful response is:

```json
{"operation_id":"…","digest":"…","state":"pending","snapshot_json":"…","package_id":"…","publication_approval":false}
```

Before returning it, the session performs a fresh operation lookup, anchors the digest to the durable receipt, checks the full remote binding, rechecks the current saved note, labels, approved images, package/compiler, and inventory, then reads the remote snapshot. It does not use producer-rendered HTML as a substitute. A lost prepare response may be reconciled against the same operation ID; this route never retries or creates an operation. Source or asset drift, expired/changed remote state, identity or digest mismatch, unsupported markup, and malformed or noncanonical JSON all fail closed.

The selected source must already be saved: prepare reads the selected file from disk, and frozen read-back rechecks those saved bytes. Unsaved-editor text is not used. The existing authenticated `/v1/assets/{package-id}/…` route remains the only local package-asset reader; it is constrained by the locally verified package inventory. The returned flag `publication_approval: false` is informational only; reviewer approval and publisher commit remain separate, unchanged workflows.

## Current WordPress markup boundary

On pinned WordPress 7.1.2, `the_content` otherwise adds `decoding="async"`, which the review page's KSES removes. During initial freeze, a scoped filter omits it only for canonical PNG resource URLs in the verified manifest inventory. During later real `the_content` rendering, a registered filter does the same only for the exact same-site resource URL backed by the operation's stored PNG inventory. Neither filter expands KSES or rewrites an existing snapshot. Ordinary and foreign image URLs remain unchanged.

The real persistent WordPress integration verifies PNG owner and authenticated loopback read-back, byte equality with KSES and actual `the_content`, and rejection after a later filter forces unsupported output. Pretty and query URL matching are additionally exercised at the PHP hook boundary; this is not a query-form HTTP routing acceptance test.

## Compatibility and remaining acceptance

New operation digests use canonical snapshot JSON. Legacy policy digests still use `pubv1_digest`; old operation records are not migrated or claimed compatible. Server PHP source bytes remain part of the policy fingerprint, so replacing server code invalidates previously frozen inputs. This candidate is isolated and is not a deployment or upgrade of existing production operations.

Plugin frozen-view integration, real reviewer browser handoff, human approval, native acceptance, and production deployment remain separate gates. Automated reviewer decisions in the integration fixture are explicitly SIMULATED.
