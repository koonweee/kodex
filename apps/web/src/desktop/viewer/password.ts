import type RFB from "@desktop-vendor/core/rfb.js";
import type { components } from "../../api/generated/schema";

type Context = {target: Pick<RFB,"sendKey"> | null; active:boolean; ready:boolean; secure:boolean; revision:number};
export function passwordError(value:string): string | null {
  if (!value || new TextEncoder().encode(value).byteLength > 256) return "Enter a Mac password of at most 256 UTF-8 bytes.";
  for (const point of value) {
    const code=point.codePointAt(0)!;
    if (code < 32 || (code >= 127 && code <= 159) || (code >= 0xd800 && code <= 0xdfff)) return "The password contains an unsupported control character.";
  }
  return null;
}

// One volatile, explicit entry on the same visible transport. No credential RPC,
// clipboard, saved draft, fallback authentication, input retry or delayed replay.
export function createPasswordEntry(context:()=>Context,
  read:(signal:AbortSignal)=>Promise<components["schemas"]["DesktopConsoleState"]>) {
  let pending:AbortController|undefined;
  return {
    cancel(){ pending?.abort(); },
    async send(secret:string) {
      const invalid=passwordError(secret);
      if(invalid) throw new Error(invalid);
      const before=context();
      if (!before.secure) throw new Error("Use HTTPS to enter the Mac password.");
      if (!before.target || !before.active || !before.ready) throw new Error("Wait for a live Desktop preview.");
      if (pending) throw new Error("A password entry is already pending.");
      const controller = pending = new AbortController();
      let timedOut=false;
      const timer=setTimeout(()=>{timedOut=true;controller.abort();},3000);
      let onAbort:()=>void = ()=>{};
      const canceled=new Promise<never>((_,reject)=>{
        onAbort=()=>reject(new Error(timedOut ? "The Mac lock state could not be verified." : "Desktop changed before password entry. Check the preview and try again."));
        controller.signal.addEventListener("abort",onAbort,{once:true});
      });
      try {
        const state=await Promise.race([read(controller.signal).catch(()=>{throw new Error("The Mac lock state could not be verified.");}),canceled]);
        const now=context();
        if (controller.signal.aborted || now.target!==before.target || now.revision!==before.revision || !now.active || !now.ready || !now.secure) throw new Error("Desktop changed before password entry. Check the preview and try again.");
        if (state!=="locked") throw new Error("The Mac is no longer confirmed locked. Check the preview.");
        try {
          for (const point of secret) {
            const code=point.codePointAt(0)!;
            before.target.sendKey(code<=255 ? code : 0x01000000|code);
          }
          before.target.sendKey(0xff0d,"Enter");
        } catch {throw new Error("Password entry was interrupted. Check the Mac before trying again.");}
      } finally {
        secret=""; clearTimeout(timer); controller.signal.removeEventListener("abort",onAbort);
        if (pending===controller) pending=undefined;
      }
    },
  };
}
