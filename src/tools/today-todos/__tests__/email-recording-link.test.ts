/**
 * Tests for extractRecordingLink — pulls a Zoom cloud-recording URL out of a
 * meeting-summary email body so the task can link straight to the recording.
 *
 * A bug here either drops the link (user has to dig through email) or
 * returns a malformed URL (trailing quote/bracket from HTML bodies).
 */

import { extractRecordingLink } from "../email-utils";

describe("extractRecordingLink", () => {
  it("extracts a subdomain /rec/share/ link from plain text", () => {
    const body =
      "Your recording is ready: https://us02web.zoom.us/rec/share/abc123XYZ?pwd=foo thanks";
    expect(extractRecordingLink(body)).toBe("https://us02web.zoom.us/rec/share/abc123XYZ?pwd=foo");
  });

  it("extracts a subdomain /rec/play/ link", () => {
    const body = "Watch here https://keycard.zoom.us/rec/play/def456";
    expect(extractRecordingLink(body)).toBe("https://keycard.zoom.us/rec/play/def456");
  });

  it("extracts a bare zoom.us /rec/ link", () => {
    const body = "Link: http://zoom.us/rec/xyz789";
    expect(extractRecordingLink(body)).toBe("http://zoom.us/rec/xyz789");
  });

  it("stops at HTML attribute and tag delimiters", () => {
    const body = '<a href="https://us06web.zoom.us/rec/share/abc">View</a>';
    expect(extractRecordingLink(body)).toBe("https://us06web.zoom.us/rec/share/abc");

    const angled = "<https://us06web.zoom.us/rec/share/abc>";
    expect(extractRecordingLink(angled)).toBe("https://us06web.zoom.us/rec/share/abc");
  });

  it("matches case-insensitively", () => {
    const body = "HTTPS://US02WEB.ZOOM.US/REC/SHARE/ABC";
    expect(extractRecordingLink(body)).toBe("HTTPS://US02WEB.ZOOM.US/REC/SHARE/ABC");
  });

  it("prefers a /rec/share/ link over a /rec/play/ link regardless of position", () => {
    const body = "Play: https://a.zoom.us/rec/play/111 Share: https://a.zoom.us/rec/share/222";
    expect(extractRecordingLink(body)).toBe("https://a.zoom.us/rec/share/222");
  });

  it("returns null when there is no recording link", () => {
    expect(extractRecordingLink("")).toBeNull();
    expect(extractRecordingLink("No links here")).toBeNull();
    expect(extractRecordingLink("Join: https://us02web.zoom.us/j/123456789")).toBeNull();
    expect(extractRecordingLink("https://example.com/rec/share/abc")).toBeNull();
  });
});
