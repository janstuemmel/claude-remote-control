const DEFAULT_MAX_ROWS = 100;

/**
 * A deliberately small terminal screen renderer for status-oriented CLI output.
 * It supports the cursor and erase sequences used by terminal UI libraries while
 * ignoring colors and other presentation-only control codes.
 */
export class TerminalScreen {
  private lines: string[] = [""];
  private row = 0;
  private column = 0;
  private savedRow = 0;
  private savedColumn = 0;
  private pendingEscape = "";

  constructor(private readonly maxRows = DEFAULT_MAX_ROWS) {}

  reset(): void {
    this.lines = [""];
    this.row = 0;
    this.column = 0;
    this.savedRow = 0;
    this.savedColumn = 0;
    this.pendingEscape = "";
  }

  write(chunk: string): void {
    const input = this.pendingEscape + chunk;
    this.pendingEscape = "";

    for (let index = 0; index < input.length;) {
      const character = input[index];

      if (character === "\u001b") {
        const sequence = readEscapeSequence(input, index);
        if (!sequence) {
          this.pendingEscape = input.slice(index);
          break;
        }
        this.applyEscape(sequence);
        index += sequence.length;
        continue;
      }
      if (character === "\r") {
        this.column = 0;
      } else if (character === "\n") {
        this.row += 1;
        this.column = 0;
        this.ensureRow();
      } else if (character === "\b") {
        this.column = Math.max(0, this.column - 1);
      } else if (character === "\t") {
        this.column = Math.ceil((this.column + 1) / 8) * 8;
      } else if (character >= " ") {
        this.writeCharacter(character);
      }
      index += 1;
    }
  }

  toLines(): string[] {
    const lines = this.lines.map((line) => line.trimEnd());
    while (lines.length > 0 && !lines.at(-1)) lines.pop();
    return lines.slice(-this.maxRows);
  }

  private writeCharacter(character: string): void {
    this.ensureRow();
    const line = this.lines[this.row] ?? "";
    const padded = line.padEnd(this.column, " ");
    this.lines[this.row] = `${padded.slice(0, this.column)}${character}${padded.slice(this.column + 1)}`;
    this.column += 1;
  }

  private applyEscape(sequence: string): void {
    if (!sequence.startsWith("\u001b[")) return;
    const command = sequence.at(-1)!;
    const rawParameters = sequence.slice(2, -1).replace(/^\?/, "");
    const parameters = rawParameters.split(";").map((value) => value === "" ? 0 : Number(value));
    const amount = parameters[0] || 1;

    switch (command) {
      case "A": this.row = Math.max(0, this.row - amount); break;
      case "B": this.row += amount; this.ensureRow(); break;
      case "C": this.column += amount; break;
      case "D": this.column = Math.max(0, this.column - amount); break;
      case "E": this.row += amount; this.column = 0; this.ensureRow(); break;
      case "F": this.row = Math.max(0, this.row - amount); this.column = 0; break;
      case "G": this.column = Math.max(0, amount - 1); break;
      case "H":
      case "f":
        this.row = Math.max(0, (parameters[0] || 1) - 1);
        this.column = Math.max(0, (parameters[1] || 1) - 1);
        this.ensureRow();
        break;
      case "d": this.row = Math.max(0, amount - 1); this.ensureRow(); break;
      case "J": this.eraseDisplay(parameters[0] ?? 0); break;
      case "K": this.eraseLine(parameters[0] ?? 0); break;
      case "P": this.deleteCharacters(amount); break;
      case "X": this.eraseCharacters(amount); break;
      case "s": this.savedRow = this.row; this.savedColumn = this.column; break;
      case "u": this.row = this.savedRow; this.column = this.savedColumn; this.ensureRow(); break;
      // Styling, cursor visibility, and terminal modes do not affect text layout.
      default: break;
    }
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.lines = [""];
      this.row = 0;
      this.column = 0;
      return;
    }
    if (mode === 0) {
      this.eraseLine(0);
      this.lines.splice(this.row + 1);
    } else if (mode === 1) {
      this.lines.splice(0, this.row, ...Array.from({ length: this.row }, () => ""));
      this.eraseLine(1);
    }
  }

  private eraseLine(mode: number): void {
    this.ensureRow();
    const line = this.lines[this.row] ?? "";
    if (mode === 2) this.lines[this.row] = "";
    else if (mode === 1) this.lines[this.row] = `${" ".repeat(this.column + 1)}${line.slice(this.column + 1)}`;
    else this.lines[this.row] = line.slice(0, this.column);
  }

  private deleteCharacters(amount: number): void {
    this.ensureRow();
    const line = this.lines[this.row] ?? "";
    this.lines[this.row] = `${line.slice(0, this.column)}${line.slice(this.column + amount)}`;
  }

  private eraseCharacters(amount: number): void {
    this.ensureRow();
    const line = (this.lines[this.row] ?? "").padEnd(this.column + amount, " ");
    this.lines[this.row] = `${line.slice(0, this.column)}${" ".repeat(amount)}${line.slice(this.column + amount)}`;
  }

  private ensureRow(): void {
    while (this.lines.length <= this.row) this.lines.push("");
    if (this.lines.length > this.maxRows) {
      const overflow = this.lines.length - this.maxRows;
      this.lines.splice(0, overflow);
      this.row = Math.max(0, this.row - overflow);
      this.savedRow = Math.max(0, this.savedRow - overflow);
    }
  }
}

function readEscapeSequence(input: string, start: number): string | undefined {
  const remainder = input.slice(start);
  if (remainder.startsWith("\u001b[")) {
    const match = remainder.match(/^\u001b\[[0-?]*[ -/]*[@-~]/);
    return match?.[0];
  }
  if (remainder.startsWith("\u001b]")) {
    const bell = remainder.indexOf("\u0007", 2);
    const terminator = remainder.indexOf("\u001b\\", 2);
    const end = bell >= 0 && (terminator < 0 || bell < terminator) ? bell + 1 : terminator >= 0 ? terminator + 2 : -1;
    return end >= 0 ? remainder.slice(0, end) : undefined;
  }
  return remainder.length >= 2 ? remainder.slice(0, 2) : undefined;
}
