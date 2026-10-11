export function buildIframeDocumentReceiverScript() {
  return `window.__iframePaintChallenge={challengeId:'boot',rgb:[217,232,255]};
const rgbText=rgb=>'rgb('+rgb.join(', ')+')';
window.addEventListener('message',event=>{if(event.data?.type==='iframe-paint-challenge'){
  window.__iframePaintChallenge={challengeId:event.data.challengeId,rgb:event.data.rgb};
  document.body.style.backgroundColor=rgbText(event.data.rgb);
  parent.postMessage({type:'iframe-challenge-painted',challengeId:event.data.challengeId,rgb:event.data.rgb},'*');
}});`;
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
