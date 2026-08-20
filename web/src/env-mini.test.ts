// probe
import { describe, expect, it } from "vitest";
describe("p", () => { it("env", () => { expect(typeof window).toBe("object"); expect(typeof localStorage).toBe("object"); }); });
