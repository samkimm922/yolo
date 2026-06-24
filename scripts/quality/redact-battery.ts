// Quality-score redaction battery: known provider/log secrets must be masked
// before persistence, including nested provider output objects.

import { redact, redactDeep } from "../../src/lib/security/redact.js";

type RedactBatteryCase = {
  id: string;
  category: "redaction_robustness";
  description: string;
  expect: "redacted";
  secret: string;
  input: unknown;
};

type RedactBatteryResult = {
  id: string;
  category: string;
  expect: string;
  actualExit: number;
  actualStatus: string;
  correct: boolean;
};

const slackToken = "xox" + "b-123456789012-123456789012-abcdefghijklmnopqrstuvwxyz";
const googleApiKey = "AI" + "zaSyD1234567890abcdefghijklmnopqrstuvwx";
const stripeSecret = "sk" + "_live_1234567890abcdefghijklmnop";
const stripeRestricted = "rk" + "_live_1234567890abcdefghijklmnop";
const jwtToken = "ey" + "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
const hexToken = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const REDACT_BATTERY: RedactBatteryCase[] = [
  {
    id: "redact_slack_token",
    category: "redaction_robustness",
    description: "Slack xox tokens must be masked.",
    expect: "redacted",
    secret: slackToken,
    input: `token ${slackToken}`,
  },
  {
    id: "redact_google_api_key",
    category: "redaction_robustness",
    description: "Google AIza API keys must be masked.",
    expect: "redacted",
    secret: googleApiKey,
    input: `google ${googleApiKey}`,
  },
  {
    id: "redact_stripe_secret_key",
    category: "redaction_robustness",
    description: "Stripe live secret keys must be masked.",
    expect: "redacted",
    secret: stripeSecret,
    input: `stripe ${stripeSecret}`,
  },
  {
    id: "redact_stripe_restricted_key",
    category: "redaction_robustness",
    description: "Stripe restricted live keys must be masked.",
    expect: "redacted",
    secret: stripeRestricted,
    input: `stripe ${stripeRestricted}`,
  },
  {
    id: "redact_jwt_token",
    category: "redaction_robustness",
    description: "JWT-shaped tokens must be masked.",
    expect: "redacted",
    secret: jwtToken,
    input: `jwt ${jwtToken}`,
  },
  {
    id: "redact_bare_hex_token",
    category: "redaction_robustness",
    description: "Bare 40-64 character hex secrets must be masked.",
    expect: "redacted",
    secret: hexToken,
    input: `digest ${hexToken}`,
  },
  {
    id: "redactDeep_on_nested_provider_stdout",
    category: "redaction_robustness",
    description: "Nested provider stdout must be deep-redacted before persistence.",
    expect: "redacted",
    secret: slackToken,
    input: {
      providerRun: {
        stdout: {
          nested: `leaked ${slackToken}`,
        },
      },
    },
  },
];

export function runRedactBattery(): RedactBatteryResult[] {
  return REDACT_BATTERY.map((testCase) => {
    const redacted = typeof testCase.input === "string"
      ? redact(testCase.input)
      : redactDeep(testCase.input);
    const serialized = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
    const status = serialized.includes(testCase.secret) ? "leaked" : "redacted";
    const correct = status === testCase.expect;
    return {
      id: testCase.id,
      category: testCase.category,
      expect: testCase.expect,
      actualExit: correct ? 0 : 1,
      actualStatus: status,
      correct,
    };
  });
}
