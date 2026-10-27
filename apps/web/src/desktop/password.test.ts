import { afterEach, describe, expect, it, vi } from "vitest";
import { createPasswordEntry, passwordError } from "./viewer/password";

function fixture() {
  const target={sendKey:vi.fn()};
  let current={target,active:true,ready:true,secure:true,revision:1};
  const read=vi.fn(async()=>"locked" as const);
  const sender=createPasswordEntry(()=>current,read);
  return {target,read,sender,change:(patch:Partial<typeof current>)=>{current={...current,...patch};}};
}
describe("one-shot password input",()=>{
  afterEach(()=>vi.useRealTimers());
  it("validates bounded printable Unicode before any remote read or input",async()=>{
    for(const secret of ["", "x".repeat(257), "a\nb", "a\tb", "a\0b", "\ud800"]){
      const f=fixture(); expect(passwordError(secret)).not.toBeNull();
      await expect(f.sender.send(secret)).rejects.toThrow();
      expect(f.read).not.toHaveBeenCalled(); expect(f.target.sendKey).not.toHaveBeenCalled();
    }
    expect(passwordError("Å🔑 and spaces")).toBeNull();
  });
  it("checks native lock then emits Unicode characters and Return exactly once",async()=>{
    const f=fixture(); await f.sender.send("AÅ🔑");
    expect(f.read).toHaveBeenCalledTimes(1);
    expect(f.target.sendKey.mock.calls).toEqual([[0x41],[0xc5],[0x0101f511],[0xff0d,"Enter"]]);
  });
  it("rejects inactive, unavailable and insecure previews without reading or sending",async()=>{
    for(const patch of [{active:false},{ready:false},{secure:false}]){
      const f=fixture(); f.change(patch); await expect(f.sender.send("fixture-password")).rejects.toThrow();
      expect(f.read).not.toHaveBeenCalled(); expect(f.target.sendKey).not.toHaveBeenCalled();
    }
  });
  it("cancels a delayed native read on preview change without typing or retrying",async()=>{
    const f=fixture(); let finish!:(value:"locked")=>void;
    f.read.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const sent=f.sender.send("fixture-password"); f.change({revision:2}); finish("locked");
    await expect(sent).rejects.toThrow(); expect(f.target.sendKey).not.toHaveBeenCalled();
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("fails promptly on cancel even when a reader ignores its abort signal",async()=>{
    const f=fixture(); f.read.mockImplementationOnce(()=>new Promise(()=>{}));
    const sent=f.sender.send("fixture-password"); f.sender.cancel();
    await expect(sent).rejects.toThrow(); expect(f.target.sendKey).not.toHaveBeenCalled();
  });
  it("bounds an unresponsive native preflight and never replays a partial entry",async()=>{
    vi.useFakeTimers();const f=fixture();f.read.mockImplementationOnce(()=>new Promise(()=>{}));
    const rejected=expect(f.sender.send("fixture-password")).rejects.toThrow("The Mac lock state could not be verified.");
    await vi.advanceTimersByTimeAsync(3000);await rejected;
    expect(f.target.sendKey).not.toHaveBeenCalled();expect(f.read).toHaveBeenCalledTimes(1);
    const broken=fixture();broken.target.sendKey.mockImplementation(()=>{throw new Error("fixture-password packet failed");});
    await expect(broken.sender.send("fixture-password")).rejects.toThrow("Password entry was interrupted. Check the Mac before trying again.");
    await vi.advanceTimersByTimeAsync(60000);expect(broken.target.sendKey).toHaveBeenCalledTimes(1);
  });
  it("rejects unlocked or unknown state without sending or leaking a read error",async()=>{
    for(const value of ["unlocked","unknown"]){
      const f=fixture(); f.read.mockResolvedValueOnce(value as "locked");
      await expect(f.sender.send("fixture-password")).rejects.toThrow(); expect(f.target.sendKey).not.toHaveBeenCalled();
    }
    const f=fixture(); f.read.mockRejectedValueOnce(new Error("fixture-password native reason"));
    await expect(f.sender.send("fixture-password")).rejects.toThrow("The Mac lock state could not be verified.");
  });
});
