const rtf = new Intl.RelativeTimeFormat('ko', { numeric: 'auto' });

function timeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return rtf.format(-seconds, 'second');
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return rtf.format(-minutes, 'minute');
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return rtf.format(-hours, 'hour');
    return rtf.format(-Math.floor(hours / 24), 'day');
}

function updateLabel(element) {
    const text = `${element.dataset.language} • ${timeAgo(Number(element.dataset.timestamp))}`;
    if (element.textContent !== text) element.textContent = text;
}

export function renderModifiedTime(element, { language, lastModified }) {
    if (Number.isFinite(lastModified)) {
        element.dateTime = new Date(lastModified).toISOString();
        element.dataset.language = language;
        element.dataset.timestamp = lastModified;
        updateLabel(element);
    } else {
        element.removeAttribute('datetime');
        delete element.dataset.timestamp;
        element.textContent = language;
    }
}

function updateRelativeTimes() {
    document.querySelectorAll('time[data-timestamp]').forEach(updateLabel);
    setTimeout(updateRelativeTimes, 1000 - Date.now() % 1000);
}
updateRelativeTimes();
