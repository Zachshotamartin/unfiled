import { describe, expect, it } from "vitest";

import {
  authSubmitDisabled,
  normalizedVerificationCode,
  verificationCodeChange,
  verificationCodeComplete
} from "./auth-form-rules";

describe("authSubmitDisabled", () => {
  it("requires an email and a password within the length bounds, and blocks while pending", () => {
    expect(authSubmitDisabled(false, "person@example.com", "correct horse")).toBe(false);
    expect(authSubmitDisabled(true, "person@example.com", "correct horse")).toBe(true);
    expect(authSubmitDisabled(false, "   ", "correct horse")).toBe(true);
    expect(authSubmitDisabled(false, "person@example.com", "short")).toBe(true);
    expect(authSubmitDisabled(false, "person@example.com", "x".repeat(73))).toBe(true);
  });
});

describe("the emailed code as the field holds it", () => {
  it("keeps the digits of a code however it was read back", () => {
    expect(normalizedVerificationCode("123456")).toBe("123456");
    expect(normalizedVerificationCode("123 456")).toBe("123456");
    expect(normalizedVerificationCode(" 123-456 ")).toBe("123456");
  });

  it("never holds more than the six digits the contract accepts", () => {
    expect(normalizedVerificationCode("1234567")).toBe("123456");
    expect(normalizedVerificationCode("12345678901234")).toBe("123456");
  });

  it("drops what is not a digit, so a stray letter cannot reach the API", () => {
    expect(normalizedVerificationCode("12a34b")).toBe("1234");
    expect(normalizedVerificationCode("abcdef")).toBe("");
  });

  it("is complete only at six digits, which is when the form submits itself", () => {
    expect(verificationCodeComplete("12345")).toBe(false);
    expect(verificationCodeComplete("123456")).toBe(true);
    expect(verificationCodeComplete("123 456")).toBe(true);
    expect(verificationCodeComplete("12345a")).toBe(false);
  });
});

describe("one change to the code field", () => {
  it("sends a whole code without waiting for the button", () => {
    expect(verificationCodeChange("123456")).toEqual({ code: "123456", send: true });
  });

  it("sends a code the keyboard filled in with its own spacing", () => {
    expect(verificationCodeChange("123 456")).toEqual({ code: "123456", send: true });
  });

  it("holds a part-typed code and sends nothing", () => {
    expect(verificationCodeChange("")).toEqual({ code: "", send: false });
    expect(verificationCodeChange("1")).toEqual({ code: "1", send: false });
    expect(verificationCodeChange("12345")).toEqual({ code: "12345", send: false });
  });

  it("sends the six digits it kept, never the raw keystrokes", () => {
    expect(verificationCodeChange("1234567")).toEqual({ code: "123456", send: true });
  });
});
