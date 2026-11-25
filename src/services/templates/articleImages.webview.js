let online = false;
let localBase = '';

export function displayArticleImage(img, src) {
    if (!src) return;
    if (online || src.startsWith('data:') || (localBase && src.startsWith(localBase))) {
        delete img.dataset.blockedSrc;
        if (img.getAttribute('src') !== src) img.setAttribute('src', src);
    } else {
        img.dataset.blockedSrc = src;
        img.removeAttribute('src');
    }
}

export function setArticleImagePolicy(enabled, localImageBase = '') {
    if (online === enabled && localBase === localImageBase) return;
    online = enabled;
    localBase = localImageBase;
    for (const img of document.images) displayArticleImage(img, img.dataset.blockedSrc || img.getAttribute('src'));
}

export function renderArticlePreview(element, html) {
    // Images in a template do not start loading until inserted in the document.
    const template = document.createElement('template');
    template.innerHTML = html;
    if (!online) {
        for (const img of template.content.querySelectorAll('img[src]')) displayArticleImage(img, img.getAttribute('src'));
    }
    element.replaceChildren(template.content);
}
