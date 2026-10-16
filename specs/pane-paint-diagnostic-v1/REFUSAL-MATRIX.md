Pane paint diagnostic v1 semantic matrix (specification PR; not installed)

Stage            Exact retained image prefix    Allowed read prefix length
admission        none                           0
 describe        none                           0 (describe errors use no observe checks)
before           none                           0..1
GUEST:before     none                           1..2
GUEST:capture    none                           2
GUEST:png        none                           2
GUEST:after      GUEST                          2..3
HOST:before      GUEST                          3..4
HOST:capture     GUEST                          4
HOST:png         GUEST                          4
HOST:after       GUEST,HOST                     4..5
publish          GUEST,HOST                     5..6

Read prefix is always before,GUEST:before,GUEST:after,HOST:before,HOST:after,publish.
All image prechecks and prior successful postchecks must be attached and exactly match admitted request expectation. At the failing read, state can be mismatched/detached/null and is retained as failed evidence, not a passing fence. A thrown read may leave only the preceding prefix; it cannot invent a read receipt. No later capture is permitted after failure.

Reason allowable stages
unsupported,busy: admission only
transport-limit: admission only (preflight worst-case response bound); unexpected serialization overflow uses existing ok:false content_too_large envelope, no images
stale: admission (token) or six read stages
unavailable,read-failed: describe or six read stages
capture-failed: GUEST:capture or HOST:capture
invalid-image: GUEST:png or HOST:png
 timeout: admission,describe or all observe stages, with actual elapsed>=configured budget

Action describe permits only admission/describe refusal, with no captures/checks. Action observe cannot report describe stage. Refusals echo exact request payload and envelope ID; all retained image bytes/hash/target/binding/space/dimensions and capture timings are validated against that request. Prefix count is exact, not merely an upper bound; a later-stage error cannot drop validated prior evidence. Size-bound/invalid image uses invalid-image at target:png; rejection before any image was obtained uses its actual preceding capture/read stage. Unknown stages/reasons are schema-invalid.

Observed success uses six passing read checks and GUEST,HOST, with:
initial <= GUEST-before <= GUEST-start <= GUEST-end <= GUEST-after <= HOST-before <= HOST-start <= HOST-end <= HOST-after <= publish <= elapsed <= configuredBudget.
Refused image completions likewise cannot exceed the configured budget; later native replies are not admitted. Actual refused check/elapsed/drain times may exceed that budget without clamping, within finite safe-number representation. Completed drain offset cannot exceed the elapsed time of the receipt that reports it. Pending drain reports no future completion timestamp; later internal completion releases capacity without a second response/image.
