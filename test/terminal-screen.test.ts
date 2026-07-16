import { describe, expect, it } from "vitest";
import { TerminalScreen } from "../src/process/terminal-screen.js";

describe("TerminalScreen", () => {
  it("renders ordinary output as screen rows", () => {
    const terminal = new TerminalScreen();
    terminal.write("Connected\nCapacity 0/32\nWaiting for sessions");
    expect(terminal.toLines()).toEqual(["Connected", "Capacity 0/32", "Waiting for sessions"]);
  });

  it("replaces lines redrawn with ANSI cursor and erase sequences", () => {
    const terminal = new TerminalScreen();
    terminal.write("Connecting\nCapacity 0/32\nWaiting");
    terminal.write("\u001b[2K\u001b[1A\u001b[2K\u001b[1A\u001b[2K\u001b[G");
    terminal.write("Connected\nCapacity 1/32\nSession active");

    expect(terminal.toLines()).toEqual(["Connected", "Capacity 1/32", "Session active"]);
  });

  it("handles screen clears and escape sequences split across chunks", () => {
    const terminal = new TerminalScreen();
    terminal.write("Old interface");
    terminal.write("\u001b[");
    terminal.write("2JNew interface");
    expect(terminal.toLines()).toEqual(["New interface"]);
  });
});
