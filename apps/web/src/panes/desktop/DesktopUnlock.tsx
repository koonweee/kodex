import { Alert, Button, Checkbox, PasswordInput, Text } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { readDesktopSession } from "../../api/desktop";
import { queryKeys } from "../../api/queryKeys";
import { passwordError } from "../../desktop/viewer/password";

type Props = {
  ready:boolean;
  revision:number;
  send:(password:string)=>Promise<void>;
  cancel:()=>void;
  onFocusChange:(focused:boolean)=>void;
};

async function waitForUnlock(signal:AbortSignal) {
  while(!signal.aborted) {
    const value=await readDesktopSession(signal);
    if(value==="unlocked") return;
    await new Promise<void>((resolve,reject)=>{
      const stop=()=>{clearTimeout(timer);reject(new Error("canceled"));};
      const timer=setTimeout(()=>{signal.removeEventListener("abort",stop);resolve();},500);
      signal.addEventListener("abort",stop,{once:true});
      if(signal.aborted) stop();
    });
  }
  throw new Error("canceled");
}

// Draft/confirmation are local to this visible pane. The Mac owns lock state;
// native reads also converge other tabs after a remote or local unlock.
export function DesktopUnlock({ready,revision,send,cancel,onFocusChange}:Props) {
  const queryClient=useQueryClient();
  const session=useQuery({queryKey:queryKeys.desktopSession,queryFn:({signal})=>readDesktopSession(signal),
    staleTime:0,refetchInterval:1000,retry:false});
  const field=useRef<HTMLInputElement>(null);
  const [password,setPassword]=useState("");
  const [confirmed,setConfirmed]=useState(false);
  const [status,setStatus]=useState<"idle"|"sending"|"verifying"|"unlocked">("idle");
  const statusRef=useRef(status); statusRef.current=status;
  const [error,setError]=useState<string|null>(null);
  const attempt=useRef(0);
  const controller=useRef<AbortController|null>(null);
  const latest=useRef({cancel,onFocusChange}); latest.current={cancel,onFocusChange};
  useLayoutEffect(()=>()=>{
    attempt.current++;controller.current?.abort();latest.current.cancel();latest.current.onFocusChange(false);
  },[]);
  const invalidateDraft=useCallback(()=>{
    if(field.current) field.current.value="";
    setPassword("");setConfirmed(false);latest.current.onFocusChange(false);
    if(statusRef.current==="sending") {
      attempt.current++;latest.current.cancel();setStatus("idle");
      setError("Desktop changed before password entry. Confirm the field again.");
    }
  },[]);
  useLayoutEffect(invalidateDraft,[ready,revision,invalidateDraft]);
  useEffect(()=>{
    const hidden=()=>{if(document.visibilityState!=="visible")invalidateDraft();};
    window.addEventListener("pagehide",invalidateDraft);
    document.addEventListener("visibilitychange",hidden);
    return ()=>{window.removeEventListener("pagehide",invalidateDraft);document.removeEventListener("visibilitychange",hidden);};
  },[invalidateDraft]);
  useEffect(()=>{
    if(session.data!=="locked") invalidateDraft();
    if(session.data==="locked" && statusRef.current==="unlocked") setStatus("idle");
  },[session.data,session.dataUpdatedAt,invalidateDraft]);

  async function submit(event:FormEvent) {
    event.preventDefault();
    if(!confirmed || !ready || session.data!=="locked" || status!=="idle") return;
    const invalid=passwordError(password);
    if(invalid){setError(invalid);return;}
    const current=++attempt.current;
    let secret=password;
    onFocusChange(false);
    setPassword("");setConfirmed(false);setError(null);setStatus("sending");
    try {
      try {await send(secret);} finally {secret="";}
      if(current!==attempt.current) return;
      setStatus("verifying");
      const check=controller.current=new AbortController();
      const deadline=setTimeout(()=>check.abort(),10000);
      try {await waitForUnlock(check.signal);}
      finally {clearTimeout(deadline);if(controller.current===check)controller.current=null;}
      if(current!==attempt.current)return;
      queryClient.setQueryData(queryKeys.desktopSession,"unlocked");
      setStatus("unlocked");
    } catch(failure) {
      if(current!==attempt.current)return;
      // Only our same-origin sender's static errors are shown. Never echo native
      // exceptions, server prose or credentials from arbitrary rejected values.
      const message=statusRef.current==="verifying"
        ? "Unlock was not confirmed. Check the Mac password field and try again."
        : failure && typeof failure==="object" && "message" in failure && typeof failure.message==="string"
          ? failure.message : "Password entry did not complete. Check the preview.";
      setError(message);setStatus("idle");
    } finally {secret="";}
  }

  if(status==="unlocked") return <Alert color="green" title="Mac unlocked">Desktop will reconnect to the Kodex display.</Alert>;
  if(status==="sending" || status==="verifying") return <Text className="kodex-desktop-status" role="status">{status==="sending" ? "Sending password once…" : "Checking that the Mac unlocked…"}</Text>;
  if(session.data!=="locked") return session.isError ? <Text className="kodex-desktop-status" size="sm">Mac lock state is unavailable. You can sign in directly in the preview.</Text> : null;
  return <section className="kodex-desktop-unlock" aria-label="Unlock Mac with preview">
    <form onSubmit={event=>void submit(event)} autoComplete="off">
      <Text size="sm" className="kodex-desktop-unlock-help">Click the Mac password field in the live preview and clear any existing dots. Then confirm below. Your password is sent once and is not saved.</Text>
      {error ? <Alert color="red" title="Mac unlock" className="kodex-desktop-unlock-help">{error}</Alert> : null}
      <PasswordInput ref={field} label="Mac login password" value={password} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
        disabled={!ready || !window.isSecureContext} onChange={event=>setPassword(event.currentTarget.value)}
        onFocus={()=>onFocusChange(true)} onBlur={()=>onFocusChange(false)} />
      <Button type="submit" disabled={!ready || !confirmed || !password || !window.isSecureContext}>Unlock Mac</Button>
      <Checkbox className="kodex-desktop-unlock-help" label="The Mac password field is selected and empty" checked={confirmed}
        disabled={!ready} onChange={event=>setConfirmed(event.currentTarget.checked)} />
      {!window.isSecureContext ? <Text size="sm" className="kodex-desktop-unlock-help">Use HTTPS to enter the Mac password.</Text> : null}
    </form>
  </section>;
}
