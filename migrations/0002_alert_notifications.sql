-- Alerts the canary has announced as raised and not yet announced as cleared.
-- A row is written only after the webhook answered 2xx, and deleted when the
-- clearing message was delivered. alert_key is `{kind}|{corridor id or empty}`.
CREATE TABLE alert_notifications (
	network TEXT NOT NULL,
	alert_key TEXT NOT NULL,
	kind TEXT NOT NULL,
	severity TEXT NOT NULL,
	corridor_id TEXT,
	since TEXT NOT NULL,
	announced_at TEXT NOT NULL,
	PRIMARY KEY (network, alert_key)
);
