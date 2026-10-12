import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUser } from "./ask-user.ts";
import { registerPromptEditor } from "./prompt-editor.ts";
import { globalSettingsPath, loadSettings, projectSettingsPath } from "./settings.ts";
import { registerStatusBar } from "./status-bar.ts";
import { registerTodoPanel } from "./todo-panel.ts";
import { registerToolCards } from "./tool-cards.ts";
import { registerTurnSeparator } from "./turn-separator.ts";
import { registerUserMessage } from "./user-message.ts";
import { registerWelcome } from "./welcome.ts";

export function registerUi(pi: ExtensionAPI) {
  const statusBar = registerStatusBar(pi);
  const toolCards = registerToolCards(pi);
  const turnSeparator = registerTurnSeparator(pi);
  const promptEditor = registerPromptEditor(pi);
  const todoPanel = registerTodoPanel(pi);
  const askUser = registerAskUser(pi);
  const welcome = registerWelcome(pi);
  const userMessage = registerUserMessage(pi);

  pi.on("session_start", (_event, ctx) => {
    const errors = loadSettings(ctx.cwd).errors;
    if (errors.length > 0 && ctx.hasUI) ctx.ui.notify(`pi-wt UI settings:\n${errors.join("\n")}`, "warning");
  });

  pi.registerCommand("wt-ui", {
    description: "Show which Work Together UI features are on",
    handler: async (_args, ctx) => {
      const flag = (on: boolean) => (on ? "on" : "off");
      ctx.ui.notify(
        [
          "pi-wt UI",
          `global settings: ${globalSettingsPath()}`,
          `project settings: ${projectSettingsPath(ctx.cwd)}`,
          `status bar: ${flag(statusBar.isEnabled())}`,
          `tool cards: ${flag(toolCards.isCardsEnabled())}`,
          `diff preview: ${flag(toolCards.isDiffEnabled())}`,
          `turn separator: ${flag(turnSeparator.isEnabled())}`,
          `editor: ${flag(promptEditor.isEnabled())}`,
          `todos: ${flag(todoPanel.isEnabled())}`,
          `ask: ${flag(askUser.isEnabled())}`,
          `welcome: ${flag(welcome.isEnabled())}`,
          `user message: ${flag(userMessage.isEnabled())}`,
        ].join(" · "),
        "info",
      );
    },
  });
}





