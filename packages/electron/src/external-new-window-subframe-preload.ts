import { ipcRenderer, webFrame } from "electron";

import {
  EXTERNAL_NEW_WINDOW_EVENT,
  externalNewWindowFrameScript,
  externalNewWindowRequestUrl,
} from "./external-new-window.js";

const isSubframe = webFrame.top?.frameToken !== webFrame.frameToken;
if (isSubframe && ipcRenderer.sendSync("surface:is-webview-guest") === true) {
  window.addEventListener(EXTERNAL_NEW_WINDOW_EVENT, (event) => {
    const url = externalNewWindowRequestUrl(
      (event as CustomEvent<unknown>).detail,
      navigator.userActivation?.isActive === true,
    );
    if (url) {
      ipcRenderer.sendToHost("surf-ace-content", { type: "external-navigation", url });
    }
  });

  void webFrame.executeJavaScript(externalNewWindowFrameScript).catch(() => undefined);
}
