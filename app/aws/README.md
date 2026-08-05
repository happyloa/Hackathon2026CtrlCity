# AWS migration seam

These files make the local-first YouBike dashboard portable to the AWS account
provided during the hackathon. They deliberately contain no credentials, no
account IDs, and no raw CSV data.

## What the SAM stack creates

`../infra/template.yaml` creates:

- A **private S3 bucket** for generated JSON/Parquet artifacts. It is not a
  public frontend bucket.
- An on-demand **DynamoDB** table for current/near-term materialized views and
  artifact manifests.
- An **API Gateway HTTP API** and Node.js 24 Lambda API shell.
- A disabled-by-default **EventBridge Scheduler** path for the ingestion and
  forecast worker.
- Lambda IAM roles for only the S3, DynamoDB, logging, and Bedrock invocation
  access needed by their respective responsibilities.

The template uses generated bucket names and a parameter file with only
non-sensitive configuration. Before the event account is disabled, export any
S3 artifacts and the deployed SAM parameters.

## Local-to-AWS adapter boundary

| Concern | Local implementation | AWS implementation |
| --- | --- | --- |
| Full dashboard artifact | filesystem/DuckDB-generated JSON | S3 object under `<prefix>/dashboard/<asOf>.json` |
| Latest/time lookup | local artifact index | DynamoDB manifest item pointing to the S3 key |
| Map/dispatch hot views | local artifact | DynamoDB materialized items; S3 remains source of full history |
| Narrative | deterministic template | `BedrockNarrativeProvider` |

`contracts.ts` is the boundary used by handlers. `s3-dynamodb-adapters.ts`
contains the composition and DynamoDB key guide, while
`bedrock-narrative.ts` is a real Bedrock runtime adapter. Do not call Bedrock
from the Nuxt client; invoke it through the API after numerical risk and
dispatch facts have already been calculated.

The currently installed package set includes the Bedrock runtime SDK only. An
AWS composition module can be added once dependencies are approved, using
`@aws-sdk/client-s3` and `@aws-sdk/lib-dynamodb` to implement
`JsonObjectStore` and `DashboardManifestIndex`. That addition belongs in a
separate dependency change, not in this infrastructure-only scaffold.

Suggested DynamoDB access patterns are documented beside
`dynamoRecordGuide`. Keep complete `DashboardArtifact` payloads and long
histories in S3: a DynamoDB item cannot exceed 400 KB.

## Handler state

`createOperationsHandler()` is Lambda-compatible and complete at the domain
boundary. It serves the dashboard, station history, alerts, dispatch plan, and
fact-grounded briefing endpoints when injected with real adapters.

`lambdaHandler` only provides `GET /health` today and returns an explicit 503
for other routes. This is intentional: the deployed endpoint must not claim to
serve live or historical data until S3 and DynamoDB adapters are assembled.

`forecast-worker.ts` is likewise a deliberate seam. The SAM parameter
`EnableForecastSchedule` defaults to `false`; it must remain disabled until
the worker is wired to the validated ETL/forecast pipeline and has passed an
end-to-end run.

## Bedrock guardrail

`BedrockNarrativeProvider` sends only `briefingFacts`, a timestamp, and static
instructions. It tells the model not to invent station names, counts, times,
or completed actions. The model ID is supplied through `BEDROCK_MODEL_ID` so
the team can select the organizer-approved model/inference profile in the
assigned region. Lambda obtains credentials from its IAM role; local testing
uses the normal AWS SDK credential chain (for example AWS SSO), never a key
checked into `.env`.

## Deployment handoff

From `app/`, once the organizer has supplied an AWS account and region:

```powershell
sam validate --template-file infra/template.yaml
sam build --template-file infra/template.yaml
sam deploy --guided --template-file infra/template.yaml
```

Use `infra/parameters.example.json` as a copyable reference while supplying
the guided values. Keep `DataMode=historical_replay` until a verified live-feed
adapter is present. Do not enable the schedule or set a Bedrock model ID until
the account's permissions and model access have been tested.

Nuxt generation and static-site publishing are intentionally separate from this
private data stack. Point the generated Nuxt site at the `ApiUrl` stack output,
or configure a same-origin `/api` proxy behind CloudFront after the API adapter
is operational.
