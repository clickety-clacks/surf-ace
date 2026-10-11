export function buildIframeDocumentReceiverScript() {
  return `window.__iframePaintChallenge={challengeId:'boot',rgb:[217,232,255]};
const rgbText=rgb=>'rgb('+rgb.join(', ')+')';
window.addEventListener('message',event=>{if(event.data?.type==='iframe-paint-challenge'){
  window.__iframePaintChallenge={challengeId:event.data.challengeId,rgb:event.data.rgb};
  document.body.style.backgroundColor=rgbText(event.data.rgb);
  parent.postMessage({type:'iframe-challenge-painted',challengeId:event.data.challengeId,rgb:event.data.rgb},'*');
}});`;
}

export function serializeHtmlScriptString(value) {
  if (typeof value !== "string") throw new Error("Inline-script JSON value must be a string");
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function buildNativeScaleIframeHtml() {
  return `<!doctype html><html><head><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#d9e8ff}</style></head>
<body><script>
${buildIframeDocumentReceiverScript()}
window.addEventListener('pointermove',event=>parent.postMessage({type:'iframe-pointer',x:event.clientX,y:event.clientY,
  challengeId:window.__iframePaintChallenge.challengeId,rgb:window.__iframePaintChallenge.rgb},'*'));
</script></body></html>`;
}

export function buildNativeScaleGuestHtml(iframeHtml) {
  if (typeof iframeHtml !== "string" || !iframeHtml.startsWith("<!doctype html>")) {
    throw new Error("Iframe document must be a complete HTML document");
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{box-sizing:border-box;margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#fff}
#marker{position:fixed;left:-20px;top:-20px;width:8px;height:8px;background:#e22;pointer-events:none}
#edge-frame{position:fixed;right:0;bottom:0;width:130px;height:100px;border:0}
</style></head><body><div id="marker"></div><iframe id="edge-frame"></iframe><script>
window.__pointerSamples=[];
window.__nativeScaleChallenge={challengeId:'boot',rgb:[238,34,34]};window.__iframeChallengeAck=null;
const marker=document.querySelector('#marker');
window.addEventListener('pointermove',event=>{
  marker.style.left=event.clientX+'px';marker.style.top=event.clientY+'px';
  window.__pointerSamples.push({x:event.clientX,y:event.clientY,challengeId:window.__nativeScaleChallenge.challengeId});
});
${buildGuestMessageReceiverScript()}
document.querySelector('#edge-frame').srcdoc=${serializeHtmlScriptString(iframeHtml)};
</script></body></html>`;
}

export function buildGuestMessageReceiverScript() {
  return `window.__iframePointer=null;window.__iframePointerCount=0;window.__iframeChallengeAck=null;
window.addEventListener('message',event=>{
  if(event.data?.type==='iframe-pointer'){window.__iframePointer=event.data;window.__iframePointerCount++}
  if(event.data?.type==='iframe-challenge-painted')window.__iframeChallengeAck=event.data;
});`;
}

export function buildIframeChallengeGuestProgram(paint) {
  if (!paint || typeof paint.challengeId !== "string" || !Array.isArray(paint.rgb) || paint.rgb.length !== 3 ||
      paint.rgb.some((channel) => !Number.isSafeInteger(channel) || channel < 0 || channel > 255)) {
    throw new Error("Iframe paint challenge is invalid");
  }
  const message = { type: "iframe-paint-challenge", challengeId: paint.challengeId, rgb: [...paint.rgb] };
  return `(()=>{const message=${JSON.stringify(message)};document.querySelector('#edge-frame').contentWindow.postMessage(message,'*');return true})()`;
}

export function buildIframeChallengeHostProgram(guestProgram) {
  if (typeof guestProgram !== "string" || guestProgram.length === 0) throw new Error("Iframe guest program is required");
  return `(async()=>{const view=document.querySelector('webview');return view.executeJavaScript(${JSON.stringify(guestProgram)});})()`;
}

export function buildIframeChallengeAckHostProgram(challengeId) {
  if (typeof challengeId !== "string" || challengeId.length === 0) throw new Error("Iframe challenge identity is required");
  const guestProgram = "(()=>window.__iframeChallengeAck?.challengeId||null)()";
  return `(async()=>{const view=document.querySelector('webview');const state=await view.executeJavaScript(${JSON.stringify(guestProgram)});return state===${JSON.stringify(challengeId)}})()`;
}
