# crust — contract review for generated fixtures

A checklist for reviewing `gen-fixtures` output **against the API contract
before running anything against a target**. The generator derives requests
from a schema; it cannot know your backend's status conventions, concealment
policies, business preconditions, or cleanup behavior. This review is where a
human closes that gap: expected statuses, negative-case isolation, flow
assumptions and execution boundaries are checked against the authoritative
contract *first*, so a generated case is never mistaken for a verified one.

**Who runs it:** the human author or reviewer of the generated suite — not
the generator, and not an agent acting without a recorded review. Fill the
review record, work through sections A–H, and end with the decision below.

**Approval here grants no execution permission.** Approving this review
approves the *expectations*; running the generated cases against any target
requires its own separately recorded approval (section G).

## Review record

- API/service:
- Contract path:
- Contract revision:
- Backend revision, if available:
- Crust version:
- Reviewer:
- Review date:
- Generated output directory:
- Intended execution scope:
- Unresolved discrepancies:

## A. Establish the source of truth

- [ ] Identify the authoritative API contract.
- [ ] Record its revision.
- [ ] Distinguish documented behavior from implementation observations.
- [ ] Record disagreements without silently choosing whichever makes tests pass.
- [ ] Keep static source-review findings separate from runtime-observed failures.

## B. Review expected statuses

For each generated case type:

- [ ] Missing credentials.
- [ ] Invalid credentials.
- [ ] Authenticated but unauthorized identity.
- [ ] Unknown resource identifier.
- [ ] Missing required field.
- [ ] Incorrect field type.
- [ ] Invalid enum value.
- [ ] String, numeric, and pattern boundary violations.
- [ ] Unexpected property.
- [ ] Unsupported method or lifecycle operation, where applicable.

Confirm:

- [ ] Status expectations come from the reviewed contract.
- [ ] Validation cases do not automatically assume `400`.
- [ ] Authorization cases account for intentional `404` concealment.
- [ ] Unknown-ID cases use syntactically valid identifiers.
- [ ] Broad alternatives such as "400 or 422" are used only when explicitly contractual.

## C. Validate negative-case isolation

- [ ] Establish an otherwise valid baseline request.
- [ ] Change one intended condition per case.
- [ ] Ensure unrelated fields remain valid.
- [ ] Ensure referenced resources exist and belong to the intended scope.
- [ ] Use an identity that reaches the intended validation layer.
- [ ] Check structured error evidence when the contract provides it.
- [ ] Avoid asserting unstable human-readable wording unnecessarily.
- [ ] Record cases where attribution cannot be established.

## D. Review schemas and payloads

- [ ] Request and response schemas are treated separately.
- [ ] Required, nullable, and optional fields are distinguished.
- [ ] Unknown-property policy is verified.
- [ ] Defaults, transformations, and redacted fields are considered.
- [ ] Generated values satisfy supported constraints.
- [ ] Unsupported patterns or schema features are identified.
- [ ] Skipped cases are recorded with reasons.
- [ ] Response-schema validation limitations are documented.
- [ ] The actual generated fixtures are inspected, not only generator stdout.

## E. Review CRUD flow assumptions

- [ ] Create/read/update/delete operations actually exist.
- [ ] Create payloads satisfy business preconditions.
- [ ] Resource IDs are captured from the documented response location.
- [ ] Update semantics are understood.
- [ ] Asynchronous effects and eventual consistency are addressed.
- [ ] Read-after-delete expectations match the contract.
- [ ] External references and required foreign keys are resolved safely.
- [ ] Resource ownership is explicit.
- [ ] Cleanup behavior is defined for both success and failure.
- [ ] Unsupported flows are reported rather than represented as covered.

## F. Preserve generation boundaries

- [ ] Use a dedicated generated output directory.
- [ ] Confirm regeneration cannot delete manual fixtures.
- [ ] Never hand-edit generated fixtures.
- [ ] Keep application-specific manual coverage separate.
- [ ] Review regeneration diffs.
- [ ] Separate regeneration changes from unrelated edits.

## G. Approve execution separately

- [ ] Target origin approved.
- [ ] Identity and role approved.
- [ ] Resource scope approved.
- [ ] Writes approved.
- [ ] Cleanup approved.
- [ ] Required transport and redirect safeguards supported.
- [ ] Secrets are supplied through approved mechanisms and are not logged.
- [ ] Load has separate bounded non-production approval.
- [ ] Examples and configured URLs are not treated as permission to execute.

## H. Classify outcomes

For each failure, record one of:

| Classification | Required response |
|---|---|
| Backend defect | Preserve evidence and report the contract violation |
| Contract defect | Review and correct the authoritative contract |
| Generator assumption | Record the limitation and use supported configuration or manual native coverage |
| Environment/setup failure | Correct prerequisites without weakening assertions |
| Incorrect test | Correct the test with a documented contractual basis |
| Unresolved discrepancy | Leave explicitly unresolved; do not claim coverage passed |

## Review decision

Choose one:

- Approved for the specified execution scope.
- Approved with listed exclusions.
- Blocked by listed contract or safety gaps.

### Exclusions and gaps

| Operation/case | Gap | Evidence | Follow-up |
|---|---|---|---|
| | | | |

Approval of this review does not grant permissions beyond the explicitly
recorded execution scope.
