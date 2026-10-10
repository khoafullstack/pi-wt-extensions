import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAskUser } from "./ask-user.ts";
import { registerPromptEditor } from "./prompt-editor.ts";
import { registerStatusBar } from "./status-bar.ts";
import { registerTodoPanel } from "./todo-panel.ts";
import { registerToolCards } from "./tool-cards.ts";
import { registerTurnSeparator } from "./turn-separator.ts";
import { registerUserMessage } from "./user-message.ts";
import { registerWelcome } from "./welcome.ts";

export default function (pi: ExtensionAPI) {
  const statusBar = registerStatusBar(pi);
  const toolCards = registerToolCards(pi);
  const turnSeparator = registerTurnSeparator(pi);
  const promptEditor = registerPromptEditor(pi);
  const todoPanel = registerTodoPanel(pi);
  const askUser = registerAskUser(pi);
  const welcome = registerWelcome(pi);
  const userMessage = registerUserMessage(pi);

  pi.registerCommand("wt-ui", {
    description: "Hiển thị trạng thái các tính năng của pi-wt-ui",
    handler: async (_args, ctx) => {
      const flag = (on: boolean) => (on ? "on" : "off");
      ctx.ui.notify(
        [
          "pi-wt-ui",
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





