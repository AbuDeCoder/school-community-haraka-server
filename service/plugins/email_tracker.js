// Haraka Plugin: email_tracker.js

// This plugin injects a tracking pixel for email opens, rewrites all links
// for click tracking in HTML emails, and sends delivery status notifications.

const http = require("http"); // Node.js built-in HTTP module for making requests

// Constants for the plugin
const PLUGIN_NAME = "email_tracker";
const TRACKING_PIXEL_PATH = "/track-open/";
const CLICK_TRACKING_PATH = "/track-click/";
const DELIVERY_TRACKING_PATH = "/track-delivery/"; // New path for delivery status

// Default configuration (will be overridden by config/email_tracker.ini)
let config = {
  main: {
    // Ensure 'main' section exists for consistency with .ini parsing
    tracking_base_url: "http://localhost:3000", // IMPORTANT: Change this to your actual tracking server URL
  },
};

// Function to send a POST request to the tracking server
function sendTrackingEvent(eventType, emailId, data, server) {
  const trackingBaseUrl = config.main.tracking_base_url;
  let path;

  switch (eventType) {
    case "open":
      path = TRACKING_PIXEL_PATH; // Open is handled by pixel, not explicit POST
      break;
    case "click":
      path = CLICK_TRACKING_PATH; // Click is handled by redirect, not explicit POST
      break;
    case "delivered":
    case "bounced":
      path = DELIVERY_TRACKING_PATH;
      break;
    default:
      server.logerror(PLUGIN_NAME, `Unknown event type: ${eventType}`);
      return;
  }

  // For delivery events, we'll send a POST request
  if (eventType === "delivered" || eventType === "bounced") {
    const postData = JSON.stringify({
      eventType: eventType,
      emailId: emailId,
      details: data, // Contains recipient, status, etc.
      timestamp: new Date().toISOString(),
    });

    const url = new URL(`${trackingBaseUrl}${path}${emailId}`); // Construct full URL
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search, // Include path and query string
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    };

    const req = http.request(options, (res) => {
      server.logdebug(PLUGIN_NAME, `Delivery tracking response status for ${emailId}: ${res.statusCode}`);
      res.on("data", () => {}); // Consume response data to prevent memory leaks
      res.on("end", () => {});
    });

    req.on("error", (e) => {
      server.logerror(PLUGIN_NAME, `Problem with tracking request for ${emailId}: ${e.message}`);
    });

    req.write(postData);
    req.end();
  }
}

// --- Plugin Hooks ---

// init(): Called when the plugin is loaded by Haraka.
// We'll load our configuration here.
exports.hook_init = function (next, server) {
  server.logdebug(PLUGIN_NAME, "Initializing plugin...");
  // Load configuration from config/email_tracker.ini
  config = server.config.get(PLUGIN_NAME + ".ini", "ini") || config;

  if (!config.main || !config.main.tracking_base_url) {
    server.logerror(PLUGIN_NAME, "Configuration error: tracking_base_url is not set in config/email_tracker.ini. Tracking will not function correctly.");
  } else {
    server.loginfo(PLUGIN_NAME, `Tracking base URL set to: ${config.main.tracking_base_url}`);
  }
  next();
};

// hook_data(): Called after the DATA command.
// We need to set parse_body to true to access the email body later.
exports.hook_data = function (next, connection) {
  connection.transaction.parse_body = true;
  next();
};

// hook_data_post(): Called after the email data has been received and parsed.
// This is where we'll modify the HTML content.
exports.hook_data_post = function (next, connection) {
  const transaction = connection.transaction;
  const server = connection.server;

  // Get the unique ID for this email transaction
  const messageId = transaction.uuid;

  server.logdebug(PLUGIN_NAME, `Processing email with ID: ${messageId}`);

  // Recursively find and return the text/html part from the MIME body
  const getHtmlPart = (body) => {
    if (!body) return null;

    // Check if the current body part is text/html
    if (body.ct && body.ct.match(/^text\/html/i)) {
      return body;
    }

    // If it's a multipart message, iterate through its children
    if (body.children && body.children.length > 0) {
      for (const child of body.children) {
        const htmlPart = getHtmlPart(child);
        if (htmlPart) {
          return htmlPart;
        }
      }
    }
    return null;
  };

  const htmlPart = getHtmlPart(transaction.body);

  if (!htmlPart || !htmlPart.bodytext) {
    server.loginfo(PLUGIN_NAME, "No HTML part found in email or body is empty. Skipping HTML modification for tracking.");
    return next(); // Continue without modification
  }

  let htmlContent = htmlPart.bodytext;
  const trackingBaseUrl = config.main.tracking_base_url;

  // --- 1. Inject Tracking Pixel (for Open Tracking) ---
  // Ensure the pixel URL includes the messageId
  const pixelUrl = `${trackingBaseUrl}${TRACKING_PIXEL_PATH}${messageId}`;
  const trackingPixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none !important; mso-hide:all;" alt="" />`;

  // Try to insert the pixel just before the closing </body> tag
  if (htmlContent.includes("</body>")) {
    htmlContent = htmlContent.replace("</body>", `${trackingPixel}</body>`);
    server.logdebug(PLUGIN_NAME, "Tracking pixel injected.");
  } else {
    // Fallback: append to the end if no </body> tag
    htmlContent += trackingPixel;
    server.logwarn(PLUGIN_NAME, "No </body> tag found, appending tracking pixel to end of HTML.");
  }

  // --- 2. Rewrite Links (for Click Tracking) ---
  // Regex to find all <a> tags and capture their href attribute
  const linkRegex = /(<a[^>]*href=["'])([^"']*)(["'][^>]*>)/gi;

  let modifiedLinkCount = 0;
  htmlContent = htmlContent.replace(linkRegex, (match, p1, originalHref, p3) => {
    // Only track http/https links, ignore mailto:, tel:, etc.
    if (originalHref.startsWith("http://") || originalHref.startsWith("https://")) {
      const encodedOriginalHref = encodeURIComponent(originalHref);
      const trackingLink = `${trackingBaseUrl}${CLICK_TRACKING_PATH}${messageId}?url=${encodedOriginalHref}`;
      modifiedLinkCount++;
      return `${p1}${trackingLink}${p3}`; // Reconstruct the <a> tag with the new href
    }
    return match; // Return original if not an http/https link
  });

  server.logdebug(PLUGIN_NAME, `Modified ${modifiedLinkCount} links for click tracking.`);

  // --- Update the HTML part with modified content ---
  htmlPart.bodytext = htmlContent;

  server.loginfo(PLUGIN_NAME, `Email ID ${messageId} HTML processed for tracking.`);
  next(); // Continue with email processing
};

// --- New Hooks for Delivery Tracking ---

// hook_delivered(): Called when an email is successfully delivered to at least one recipient.
exports.hook_delivered = function (next, hmail, params) {
  const server = hmail.server;
  const messageId = hmail.uuid; // The transaction UUID

  server.loginfo(PLUGIN_NAME, `Email ID ${messageId} DELIVERED.`);

  // params[0] is the result object, which contains recipients that were delivered to.
  const deliveredRecipients = params[0].pass || [];

  // Send a 'delivered' event to your tracking server for each recipient
  deliveredRecipients.forEach((rcpt) => {
    sendTrackingEvent(
      "delivered",
      messageId,
      {
        recipient: rcpt.original, // The original recipient address
        dsn_status: "2.0.0", // Standard success DSN status
        dsn_message: "Delivered",
        // Add other relevant info from 'rcpt' if available and useful (e.g., rcpt.vmta)
      },
      server
    );
  });

  next();
};

// hook_bounce(): Called when an email permanently bounces (delivery failure).
exports.hook_bounce = function (next, hmail, params) {
  const server = hmail.server;
  const messageId = hmail.uuid; // The transaction UUID

  server.loginfo(PLUGIN_NAME, `Email ID ${messageId} BOUNCED.`);

  // params[0] is the result object, which contains recipients that bounced.
  const bouncedRecipients = params[0].rcpt || [];
  const dsnStatus = params[0].dsn_status || "5.X.X";
  const dsnMessage = params[0].dsn_message || "Permanent Failure";

  // Send a 'bounced' event to your tracking server for each recipient
  bouncedRecipients.forEach((rcpt) => {
    sendTrackingEvent(
      "bounced",
      messageId,
      {
        recipient: rcpt.original, // The original recipient address
        dsn_status: dsnStatus,
        dsn_message: dsnMessage,
        // Add other relevant info from 'rcpt' or 'params' if available
      },
      server
    );
  });

  next();
};

// hook_deferred(): Called when an email is temporarily deferred (will be retried later).
// You might want to track this for a full picture, but for "successful delivery"
// it's not a final status, so we'll just log it for now.
exports.hook_deferred = function (next, hmail, params) {
  const server = hmail.server;
  const messageId = hmail.uuid;

  server.loginfo(PLUGIN_NAME, `Email ID ${messageId} DEFERRED. Will retry later.`);
  // Optionally, you could send a 'deferred' event here, similar to delivered/bounced
  // sendTrackingEvent('deferred', messageId, { recipient: rcpt.original, reason: params[0].reason }, server);

  next();
};
