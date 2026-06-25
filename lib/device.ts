const DEVICE_ID_KEY = "parkquest_device_id";

export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function getLastSubmitAt(locationLabel: string): number | null {
  const raw = localStorage.getItem(`parkquest_last_submit_${locationLabel}`);
  return raw ? Number(raw) : null;
}

export function setLastSubmitAt(locationLabel: string, timestamp: number) {
  localStorage.setItem(`parkquest_last_submit_${locationLabel}`, String(timestamp));
}
