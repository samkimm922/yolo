export const UI_ACCEPTANCE_SLOT = "ui_acceptance";

export function buildUiAcceptanceFollowUp() {
  return {
    slot: UI_ACCEPTANCE_SLOT,
    plain_language_prompt: "这个 UI 功能怎么算做对？请提供项目已有的验收入口或命令、要看到的结果和证据，并粘贴完整 acceptance_adapter manifest JSON；系统不会替你选择命令。",
  };
}
