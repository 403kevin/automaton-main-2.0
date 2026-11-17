import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { CONSTITUTION_TEXT, isPrivateIp, reviewCommand, reviewText, reviewUrl } from "../src/constitution.js";

describe("constitution", () => {
  it("matches the shipped document", () => {
    expect(fs.readFileSync("constitution.md", "utf8")).toBe(CONSTITUTION_TEXT);
  });

  it("blocks harm, deception, and the owner's accounts in code", async () => {
    expect(reviewCommand("nmap -sS 10.0.0.5").allowed).toBe(false);
    expect(reviewCommand("cat ~/.ssh/id_rsa").allowed).toBe(false);
    expect(reviewCommand("echo $WALLET_MASTER_KEY").allowed).toBe(false);
    expect(reviewText("I am a human named Kevin").allowed).toBe(false);
    expect(reviewText("I am an AI and I can write this down.").allowed).toBe(true);
    expect(isPrivateIp("169.254.169.254")).toBe(true);
    const blocked = await reviewUrl("http://169.254.169.254/latest", [], async () => ["169.254.169.254"]);
    expect(blocked.allowed).toBe(false);
    const mail = await reviewUrl("https://mail.google.com/mail", [], async () => ["142.250.1.1"]);
    expect(mail.law).toBe("owner");
  });
});
