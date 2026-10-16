import { createHash } from "node:crypto";
import { isPaintState, type PaintAdapter, type PaintBinding, type PaintCapture, type PaintRect, type PaintState } from "./pane-painted-observation.js";
import { rendererPaintMatchesAuthority, type PanePaintAuthority, type PaintOwner, type RendererPaintDescriptor } from "./pane-paint-owner-bridge.js";

export type PanePaintAssociation<W extends object,H extends object,F extends object,G extends object> = {
  authority: PanePaintAuthority; renderer: RendererPaintDescriptor;
  native: { owner: PaintOwner<W,H,F>; guest: G; frame: F; frameInstanceId: string; documentGeneration: number };
};
export type PanePaintDocumentFacts = { readyState: "loading" | "interactive" | "complete"; bodyRect: PaintRect | null; backgroundColor: string; width: number; height: number; scrollX: number; scrollY: number; devicePixelRatio: number; layoutClientWidth:number;layoutClientHeight:number; visualViewport: {width:number;height:number;scale:number;offsetLeft:number;offsetTop:number}|null; scaleControl: {mode:string;nonce:string;revision:number;sequence:number;factor:number}|null };
export type PanePaintNativeImage = { getSize(): { width: number; height: number }; getScaleFactors(): number[]; toPNG(): Uint8Array };
/** Fixed, readonly client-owned recipe. No caller program, text extraction, focus, scroll or page mutation. */
export const PANE_PAINT_DOCUMENT_RECIPE = `(() => {
  const body = document.body, rect = body ? body.getBoundingClientRect() : null, control = window[Symbol.for('surf-ace.public-terminal-font-scale.v2')], vv=window.visualViewport;
  return { readyState: document.readyState, bodyRect: rect ? {x:rect.x,y:rect.y,width:rect.width,height:rect.height} : null,
    backgroundColor: body ? getComputedStyle(body).backgroundColor : "transparent", width:innerWidth,height:innerHeight,
    scrollX,scrollY,devicePixelRatio, layoutClientWidth:document.documentElement?.clientWidth ?? 0,layoutClientHeight:document.documentElement?.clientHeight ?? 0, visualViewport: vv ? {width:vv.width,height:vv.height,scale:vv.scale,offsetLeft:vv.offsetLeft,offsetTop:vv.offsetTop} : null, scaleControl: control && typeof control === "object" ? {mode:control.mode,nonce:control.hostNonce,revision:control.hostRevision,sequence:control.modeSequence,factor:control.scale} : null };
})()`;
function equal(a: unknown,b: unknown): boolean {
  if (Array.isArray(a)||Array.isArray(b)) return Array.isArray(a)&&Array.isArray(b)&&a.length===b.length&&a.every((v,i)=>equal(v,b[i]));
  if (a&&typeof a==="object" || b&&typeof b==="object") {
    if (!a||!b||typeof a!=="object"||typeof b!=="object") return false;
    const x=a as Record<string,unknown>,y=b as Record<string,unknown>;
    return Object.keys(x).length===Object.keys(y).length&&Object.keys(x).every(k=>Object.hasOwn(y,k)&&equal(x[k],y[k]));
  }
  return a===b;
}
const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER;
const sameObjects = <W extends object,H extends object,F extends object,G extends object>(a: PanePaintAssociation<W,H,F,G>,b: PanePaintAssociation<W,H,F,G>) =>
  a.native.owner.window === b.native.owner.window && a.native.owner.host === b.native.owner.host && a.native.owner.frame === b.native.owner.frame
  && a.native.guest === b.native.guest && a.native.frame === b.native.frame && a.native.frameInstanceId === b.native.frameInstanceId
  && a.native.documentGeneration === b.native.documentGeneration && equal(a.authority,b.authority) && equal(a.renderer,b.renderer)
  && a.native.owner.windowInstanceId === b.native.owner.windowInstanceId && a.native.owner.hostId === b.native.owner.hostId && a.native.owner.hostFrameKey === b.native.owner.hostFrameKey;
function transform(d: RendererPaintDescriptor): [number,number,number,number,number,number] | null {
  if (!["0px 0px","0px 0px 0px","0 0"].includes(d.transformOrigin)) return null;
  const match = /^matrix\(([^)]+)\)$/.exec(d.transform);
  const values = d.transform === "none" ? [1,0,0,1,0,0] : match?.[1].split(",").map(v=>Number(v.trim()));
  if (!values || values.length !== 6 || !values.every(finite) || values[1] !== 0 || values[2] !== 0 || values[0] <= 0 || values[3] <= 0) return null;
  if (d.scaleMode === "public-terminal-font" && (values[0] !== 1 || values[3] !== 1)) return null;
  // This qualified subset refuses rotation/shear and uses the measured transformed frame origin.
  return [values[0],0,0,values[3],d.frameRect.x,d.frameRect.y];
}
function integerCrop(r: PaintRect,host: {width:number;height:number}): boolean {
  return [r.x,r.y,r.width,r.height,host.width,host.height].every(v=>Number.isSafeInteger(v) && v>=0)
    && r.width>0 && r.height>0 && r.x+r.width<=host.width && r.y+r.height<=host.height;
}
/** Prepared only: no production caller or advertised capability. Qualification is deliberately narrow. */
export function createPanePaintCaptureAdapter<W extends object,H extends object,F extends object,G extends object>(ports: {
  associate(signal: AbortSignal): Promise<PanePaintAssociation<W,H,F,G> | null>;
  document(association: PanePaintAssociation<W,H,F,G>,signal: AbortSignal): Promise<unknown>;
  guestUrl(association: PanePaintAssociation<W,H,F,G>): string;
  guestZoom(association: PanePaintAssociation<W,H,F,G>): number;
  hostFacts(association: PanePaintAssociation<W,H,F,G>): {width:number;height:number;visible:boolean;zoom:number};
  capture(target: "GUEST"|"HOST",association: PanePaintAssociation<W,H,F,G>): Promise<PanePaintNativeImage>;
}): PaintAdapter {
  const qualified = async (signal: AbortSignal): Promise<{state:PaintState;association:PanePaintAssociation<W,H,F,G>}|null> => {
    if (signal.aborted) return null;
    const before = await ports.associate(signal);
    if (!before || signal.aborted || !rendererPaintMatchesAuthority(before.renderer,before.authority)) return null;
    const host = ports.hostFacts(before), url = ports.guestUrl(before), zoom = ports.guestZoom(before);
    if (typeof url !== "string" || url.length > 65536 || zoom !== 1 || host.zoom !== 1 || typeof host.visible !== "boolean"
      || !integerCrop(before.authority.paneRect,host)) return null; // No implicit fractional crop rounding.
    const raw = await ports.document(before,signal);
    if (signal.aborted || !raw || typeof raw !== "object") return null;
    const facts = raw as PanePaintDocumentFacts;
    if (!["loading","interactive","complete"].includes(facts.readyState) || typeof facts.backgroundColor !== "string" || facts.backgroundColor.length>512
      || ![facts.width,facts.height,facts.scrollX,facts.scrollY,facts.devicePixelRatio,facts.layoutClientWidth,facts.layoutClientHeight].every(finite) || facts.width<1 || facts.height<1 || facts.devicePixelRatio<=0) return null;
    const after = await ports.associate(signal);
    if (!after || signal.aborted || !sameObjects(before,after) || !equal(host,ports.hostFacts(after)) || ports.guestUrl(after)!==url || ports.guestZoom(after)!==zoom) return null;
    const d=after.renderer, a=after.authority, native=after.native, affine=transform(d);
    const knownDpr = facts.devicePixelRatio;
    if (knownDpr>8 || [{width:facts.width,height:facts.height},a.paneRect].some(size => {
      const width=size.width*knownDpr,height=size.height*knownDpr;
      return !finite(width)||!finite(height)||width>8192||height>8192||width*height*4>32*1024*1024;
    })) return null;
    if (d.clipRect.x<a.paneRect.x || d.clipRect.y<a.paneRect.y || d.clipRect.x+d.clipRect.width>a.paneRect.x+a.paneRect.width || d.clipRect.y+d.clipRect.height>a.paneRect.y+a.paneRect.height) return null;
    const control = facts.scaleControl, visual=facts.visualViewport;
    if (!visual || ![visual.width,visual.height,visual.scale,visual.offsetLeft,visual.offsetTop].every(finite)
      || visual.scale!==1 || visual.offsetLeft!==0 || visual.offsetTop!==0
      || visual.width<=0 || visual.height<=0 || visual.width>facts.width || visual.height>facts.height
      || (visual.width!==facts.width && visual.width!==facts.layoutClientWidth)
      || (visual.height!==facts.height && visual.height!==facts.layoutClientHeight)) return null;
    if (!affine || facts.width !== d.frameCssWidth || facts.height !== d.frameCssHeight || facts.devicePixelRatio !== d.devicePixelRatio
      || !control || control.mode!==d.scaleMode || control.nonce!==d.scaleNonce || control.revision!==d.scaleRevision || control.sequence!==d.scaleSequence
      || !Number.isSafeInteger(control.sequence) || control.sequence<1 || !finite(control.factor) || control.factor<=0 || control.factor>4
      || (d.scaleMode==="host-transform" && (control.factor!==affine[0] || control.factor!==affine[3]))) return null;
    // Native integer viewport can overhang a fractional CSS layout box. Preserve actual clip and affine,
    // rather than rescaling the reported viewport to fit that box or inventing pixel-tolerance agreement.
    const binding: PaintBinding = { surfaceId:a.surfaceId,surfaceEpoch:a.surfaceEpoch,windowInstanceId:native.owner.windowInstanceId,hostWebContentsId:native.owner.hostId,
      paneId:a.paneId,paneLineageId:a.paneLineageId,contentId:a.contentId,contentType:a.contentType,contentRevision:a.contentRevision,topologyRevision:a.topologyRevision,geometryRevision:a.geometryRevision,
      guestId:d.guestId,frameInstanceId:native.frameInstanceId+"."+d.rendererFrameInstanceId,renderGeneration:d.renderGeneration,documentGeneration:native.documentGeneration };
    const state: PaintState = { binding,hostAttached:true,guestAttached:true,
      guestDocument:{navigationUrlSha256:createHash("sha256").update(url).digest("hex"),readyState:facts.readyState,bodyRect:facts.bodyRect,backgroundColor:facts.backgroundColor},
      projection:{coordinateSpace:"surface-css-px",guestCoordinateSpace:"guest-css-px",hostRect:{...a.paneRect},clipRect:{...d.clipRect},guestViewport:{width:facts.width,height:facts.height,scrollX:facts.scrollX,scrollY:facts.scrollY},
        guestToSurface:affine,devicePixelRatio:facts.devicePixelRatio,scaleMode:d.scaleMode,scaleSequence:d.scaleSequence,scaleNonce:d.scaleNonce,scaleRevision:d.scaleRevision,hostVisible:host.visible&&d.hostVisible,opacity:d.opacity} };
    return isPaintState(state)?{state,association:after}:null;
  };
  return {
    readState: async signal => (await qualified(signal))?.state ?? null,
    capture: async (target,expected,signal): Promise<PaintCapture> => {
      if (target!=="GUEST" && target!=="HOST") throw Error("unsupported capture");
      const before=await qualified(signal);
      if (!before || signal.aborted || !equal(before.state.binding,expected.binding) || !equal(before.state.projection,expected.projection)) throw Error("stale capture owner");
      const image=await ports.capture(target,before.association);
      if (signal.aborted) throw Error("cancelled capture");
      const after=await qualified(signal);
      if (!after || signal.aborted || !sameObjects(before.association,after.association) || !equal(after.state.binding,expected.binding) || !equal(after.state.projection,expected.projection)) throw Error("changed capture owner");
      const size=image.getSize(), scales=image.getScaleFactors(), expectedSize=target==="GUEST"?expected.projection.guestViewport:expected.projection.hostRect;
      if (size.width!==expectedSize.width || size.height!==expectedSize.height || scales.length<1 || scales.length>8 || scales.some(s=>!finite(s)||s<=0)) throw Error("capture size mismatch");
      const maximum=Math.max(...scales), width=size.width*maximum,height=size.height*maximum;
      if (!finite(width)||!finite(height)||width>8192||height>8192||width*height*4>32*1024*1024) throw Error("capture allocation bounds");
      const encoded=image.toPNG();
      if (!(encoded instanceof Uint8Array)) throw Error("capture encoding unavailable");
      const bytes=Buffer.from(encoded.buffer,encoded.byteOffset,encoded.byteLength);
      const pixelWidth=bytes.length>=24?bytes.readUInt32BE(16):0,pixelHeight=bytes.length>=24?bytes.readUInt32BE(20):0;
      // Compressed-size, decoded-size, dimensions and full PNG critical order/CRC/decode checks remain in observePanePaint, before receipt retention.
      return {target,binding:structuredClone(expected.binding),png:encoded,pixelWidth,pixelHeight};
    },
  };
}
