# better-auth-bnpl

## 0.2.6

### Patch Changes

- b06350c: Allow digital-only Tabby checkouts and order history to omit shipping addresses while retaining Tamara's shipping requirement.

## 0.2.5

### Patch Changes

- b0316b4: Serialize Tabby checkout attachment bodies as JSON strings so the provider accepts and retains education data.

## 0.2.4

### Patch Changes

- deb4f6e: Send an empty name to Tabby when a buyer has not provided one instead of substituting their email address.

## 0.2.3

### Patch Changes

- 26b346b: Allow trusted server checkout resolvers to supply validated Tabby buyer history, order history, and education attachment data without exposing it through public checkout surfaces.

## 0.2.2

### Patch Changes

- 9843bfb: Accept Tamara's JSON acknowledgement when deleting a webhook.

## 0.2.1

### Patch Changes

- 7c60e68: Accept and normalize Tamara's empty webhook header array in retrieve and update responses.

## 0.2.0

### Minor Changes

- d808059: Make `captureOnAuthorise` cover Tabby authorized webhooks as well as Tamara auto-authorise flows.

### Patch Changes

- a17370d: Supply deterministic operation references when webhook-driven authorization automatically captures a payment.
