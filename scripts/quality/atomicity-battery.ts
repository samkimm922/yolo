// Quality-score capability battery (demand track): how accurately does yolo's story
// atomicity detection tell an ATOMIC requirement from a MULTI-story one?
//
// This is a CAPABILITY metric, not a robustness one: it measures how well the demand
// phase can slice work toward atomic tasks. Unlike the check battery (already hardened),
// real-world phrasing genuinely trips the detector, so this score has headroom to climb.
//
// Category maps to the user-facing goal "让需求阶段更容易达到原子任务".
//
// Expectation per case:
//   "atomic"  → inspectStoryAtomicityText must return status "pass" or "warn"
//               (a single user story; not falsely flagged as multi-story).
//   "multi"   → must return status "blocked" (genuinely several stories → needs split).

export type AtomicityExpectation = "atomic" | "multi";

export type AtomicityBatteryCase = {
  id: string;
  expect: AtomicityExpectation;
  text: string;
};

export const ATOMICITY_BATTERY: AtomicityBatteryCase[] = [
  // ── Genuinely atomic single stories (must NOT be flagged as multi) ──
  { id: "atomic-add-cart", expect: "atomic", text: "A shopper can add a product to the cart." },
  { id: "atomic-show-total", expect: "atomic", text: "Display the running order total on the checkout page." },
  { id: "atomic-validate-email", expect: "atomic", text: "Validate the email address field on the signup form." },
  { id: "atomic-format-date", expect: "atomic", text: "Format the due date as a localized short date string." },
  { id: "atomic-filter-list", expect: "atomic", text: "Filter the task list by the selected status." },
  { id: "atomic-export-csv", expect: "atomic", text: "Export the current report table to a CSV file." },

  // ── Genuinely multi-story (must be flagged as needing a split) ──
  { id: "multi-add-edit-delete", expect: "multi", text: "A user can add, edit, and delete items in the list." },
  { id: "multi-login-dashboard-profile", expect: "multi", text: "The user logs in, views the dashboard, and updates their profile." },
  { id: "multi-import-and-email", expect: "multi", text: "Import the CSV file, generate a summary report, and email it to the manager." },
  { id: "multi-build-push", expect: "multi", text: "Build the Docker image and push it to the registry." },
  { id: "multi-create-and-notify", expect: "multi", text: "Create the order and send a confirmation notification to the customer." },

  // ── or 连接的多故事（修复前被误判为 atomic）──
  { id: "multi-import-or-export", expect: "multi", text: "Users can import or export their data." },
  { id: "multi-add-or-remove", expect: "multi", text: "Admins can add or remove users." },
  { id: "multi-create-or-update", expect: "multi", text: "A user can create or update their profile." },
  { id: "multi-signup-or-login", expect: "multi", text: "Users can sign up or log in." },

  // ── Known capability gaps (currently MIS-detected as atomic → real headroom) ──
  // These slip through today: the demand phase hands the runner a too-broad task
  // instead of slicing it. The capability soak should teach the detector/splitter
  // to catch these, then add more it finds.
  { id: "multi-signup-and-login", expect: "multi", text: "Allow users to sign up and log in." },
  { id: "multi-signup-and-login-variant", expect: "multi", text: "Users can sign up and log in to the platform." },
  { id: "multi-validate-save-redirect", expect: "multi", text: "When the form is submitted, validate the inputs, save the record, and redirect to the list." },
  { id: "multi-when-clause-save-validate-persist", expect: "multi", text: "When the user saves the draft, validate the form and persist the data." },
  { id: "multi-create-account-reset-password", expect: "multi", text: "As a user, I want to create an account and reset my password." },
  { id: "multi-create-users-assign-roles", expect: "multi", text: "As an admin, I want to create users and assign roles." },
  { id: "multi-create-products-manage-inventory", expect: "multi", text: "Admins can create products and manage inventory." },
  { id: "multi-register-and-verify-email", expect: "multi", text: "Allow users to register and verify their email." },
  { id: "multi-register-and-verify-account", expect: "multi", text: "A user can register and verify their account." },
  { id: "multi-register-and-verify-device-config", expect: "multi", text: "Allow the admin to register a device and verify its configuration." },

  // ── Previously under-split: missing cancel/approve/reject in DELIVERABLE_VERB_TERMS ──
  { id: "multi-create-and-cancel-orders", expect: "multi", text: "Allow users to create and cancel orders." },
  { id: "multi-approve-or-reject", expect: "multi", text: "Managers can approve or reject requests." },
  { id: "multi-subscribe-and-cancel", expect: "multi", text: "Allow users to subscribe and cancel their subscription." },
  { id: "multi-suspend-or-reactivate", expect: "multi", text: "Moderators can suspend or reactivate accounts." },
  { id: "multi-reserve-and-cancel", expect: "multi", text: "Customers can reserve a room and cancel the reservation." },
];
