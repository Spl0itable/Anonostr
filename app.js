document.addEventListener("DOMContentLoaded", () => {
    const statusNote = document.getElementById('statusNote');
    const form = document.getElementById('eventForm');
    const noteInput = document.getElementById('note');
    const replyChainCheckbox = document.getElementById('replyChain');
    const relayHopCheckbox = document.getElementById('relayHop');
    const torRelaysCheckbox = document.getElementById('torRelays');
    const submitButton = form.querySelector('button');
    const spinner = submitButton.querySelector('.spinner');
    const relayList = document.getElementById('relayList');
    const timelineFeed = document.getElementById('timelineFeed');
    const repliesFeed = document.getElementById('repliesFeed');
    const profileModal = document.getElementById('profileModal');
    const closeModal = document.getElementById('closeModal');
    const profileBanner = document.getElementById('profileBanner');
    const profileAvatar = document.getElementById('profileAvatar');
    const profileName = document.getElementById('profileName');
    const profileNip05 = document.getElementById('profileNip05');
    const profileAbout = document.getElementById('profileAbout');
    const profileLnurl = document.getElementById('profileLnurl');
    const profileFeed = document.getElementById('profileFeed');

    // Default relays
    const defaultRelays = [
        'wss://relay.damus.io',
        'wss://relay.primal.net',
        'wss://relay.nostr.band'
    ];

    // Tor relays
    const torRelays = [
        'ws://oxtrdevav64z64yb7x6rjg4ntzqjhedm5b5zjqulugknhzr46ny2qbad.onion',
        'ws://2jsnlhfnelig5acq6iacydmzdbdmg7xwunm4xl6qwbvzacw4lwrjmlyd.onion',
        'ws://nostrnetl6yd5whkldj3vqsxyyaq3tkuspy23a3qgx7cdepb4564qgqd.onion'
    ];

    const rateLimitSeconds = 30; // 30-second delay between note sending
    const localStorageKey = 'lastSubmitTime';
    const eventIdsStorageKey = 'submittedEventIds'; // Key to store event IDs
    const seenEventIds = new Set(); // To track and deduplicate events
    const profileCache = {}; // Cache for display names and avatars

    let rootEventId = null; // Store the root event ID for threading
    let lastEventId = null; // Store the ID of the last event to reply to it in the chain

    // WebSocket references for managing subscriptions
    const wsRelays = {};

    function generateRandomHex(length) {
        const characters = '0123456789abcdef';
        let result = '';
        for (let i = 0; i < length; i++) {
            const randomIndex = Math.floor(Math.random() * characters.length);
            result += characters[randomIndex];
        }
        return result;
    }

    // Function to update the relay list display
    function updateRelayList() {
        relayList.innerHTML = ''; // Clear current list

        let selectedRelays;
        if (torRelaysCheckbox.checked) {
            selectedRelays = torRelays;
        } else {
            selectedRelays = defaultRelays;
        }

        // Populate the relay list
        selectedRelays.forEach(relayUrl => {
            const relayItem = document.createElement('li');
            relayItem.textContent = relayUrl;
            relayList.appendChild(relayItem);
        });
    }

    // Event listeners to update relay list when the checkboxes change
    torRelaysCheckbox.addEventListener('change', updateRelayList);
    relayHopCheckbox.addEventListener('change', updateRelayList);

    // Initial invocation to show the correct relays on page load
    updateRelayList();

    form.addEventListener('submit', async (event) => {
        event.preventDefault();

        try {
            const currentTime = Math.floor(Date.now() / 1000);
            const lastSubmitTime = parseInt(localStorage.getItem(localStorageKey), 10) || 0;
            const timeSinceLastSubmit = currentTime - lastSubmitTime;

            if (timeSinceLastSubmit < rateLimitSeconds) {
                const timeLeft = rateLimitSeconds - timeSinceLastSubmit;
                showNote(`Please wait ${timeLeft} second(s) before submitting again.`, 'warning');
                return;
            }

            // Reset the status note and show the spinner
            showNote('', '');
            spinner.style.display = 'inline-block';
            submitButton.disabled = true;

            // Generate a new key pair on each submit
            const sk = NostrTools.generateSecretKey();
            const pubKey = NostrTools.getPublicKey(sk);

            let note = noteInput.value.trim();
            if (!note) {
                showNote('Please enter a note.', 'error');
                resetFormState();
                return;
            }

            const tags = [];
            const bech32Regex = /@([a-z]{1,}[1][qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,})/g;

            let isRootSet = false;
            let firstMatchIsNote = false;

            // Handle mentions and note references: @npub..., @nprofile..., @note...
            const matches = note.match(bech32Regex);
            if (matches) {
                for (const match of matches) {
                    try {
                        // Decode the bech32 entity to get the hex key or ID
                        const decoded = NostrTools.nip19.decode(match.substring(1));
                        const hexKey = decoded.data;

                        if (decoded.type === 'note') {
                            // If the @note... is at the beginning, treat it as a reply and don't convert it to nostr:note
                            if (!isRootSet && note.startsWith(match)) {
                                rootEventId = hexKey;
                                tags.unshift(["e", hexKey, "", "root"]); // Ensure root event is first
                                note = note.replace(match, '').trim();
                                isRootSet = true;
                                firstMatchIsNote = true;
                            } else {
                                // If @note... is not at the beginning, convert to nostr:note
                                tags.push(["e", hexKey, "", "mention"]);
                                note = note.replace(match, `nostr:${match.substring(1)}`);
                            }
                        } else if (decoded.type === 'npub' || decoded.type === 'nprofile') {
                            tags.push(["p", hexKey, "", "mention"]);
                        }
                    } catch (error) {
                        console.error('Error decoding bech32:', error);
                    }
                }
            }

            // If reply chain is enabled and there's a last event ID, add it as a reply
            if (replyChainCheckbox.checked && lastEventId) {
                // Add the last event ID as the "reply"
                tags.push(["e", lastEventId, "", "reply"]);

                // Ensure the root event ID is included if it wasn't set above
                if (rootEventId && !isRootSet) {
                    tags.unshift(["e", rootEventId, "", "root"]);
                    isRootSet = true;
                }
            }

            // Handle hashtags: #tag
            const hashtags = note.match(/#\w+/g);
            if (hashtags) {
                for (const tag of hashtags) {
                    tags.push(["t", tag.substring(1)]);
                }
            }

            const eventTemplate = {
                kind: 1,
                pubkey: pubKey,
                created_at: Math.floor(Date.now() / 1000),
                tags: tags,
                content: note
            };

            console.log('Event Template:', eventTemplate);

            // Finalize the event (assigns the event ID, pubkey, and signs it)
            const signedEvent = NostrTools.finalizeEvent(eventTemplate, sk);
            lastEventId = signedEvent.id;

            // Store the event ID in localStorage
            saveEventId(lastEventId);

            // If this is the first event, set it as the root for future replies
            if (!rootEventId) {
                rootEventId = lastEventId;
            }

            console.log('Signed Event:', signedEvent);

            try {
                let selectedRelays;

                if (torRelaysCheckbox.checked) {
                    // Use Tor relays if the checkbox is checked
                    selectedRelays = torRelays;
                } else {
                    // Otherwise, use default relays
                    selectedRelays = defaultRelays;
                }

                let relaySuccess = false;

                if (relayHopCheckbox.checked) {
                    // If relay hop is checked, randomly select a single relay
                    let availableRelays = [...selectedRelays];

                    while (!relaySuccess && availableRelays.length > 0) {
                        const randomIndex = Math.floor(Math.random() * availableRelays.length);
                        const randomRelay = availableRelays[randomIndex];

                        const relayResult = await sendNoteToRelay(randomRelay, signedEvent);

                        if (relayResult.success) {
                            relaySuccess = true;
                            const eventId = signedEvent.id;
                            const eventLink = `https://njump.me/${eventId}`;
                            showNote(`Anon note sent successfully via relay hop! <a href="${eventLink}" target="_blank">View Event</a>`, 'success');
                            noteInput.value = '';

                            // Update the last submit time in localStorage only on success
                            localStorage.setItem(localStorageKey, currentTime);

                            // Renew subscriptions to include the new event ID
                            renewReplySubscriptions();
                        } else {
                            // Remove the failed relay from the list
                            availableRelays.splice(randomIndex, 1);
                            console.warn(`Relay hop failed for relay: ${randomRelay}. Trying another relay...`);
                        }
                    }

                    if (!relaySuccess) {
                        showNote('Relay hopping failed for all relays. Please try again later.', 'error');
                    }

                } else {
                    // Otherwise, publish to all selected relays
                    const relayResults = await Promise.all(
                        selectedRelays.map(relayUrl => sendNoteToRelay(relayUrl, signedEvent))
                    );

                    const successfulRelays = relayResults.filter(result => result.success).length;

                    if (successfulRelays === 0) {
                        // If no relays were successful
                        showNote('No relays available. Please try again later.', 'error');
                    } else {
                        // Create a link to view the event on njump.me
                        const eventId = signedEvent.id;
                        const eventLink = `https://njump.me/${eventId}`;
                        showNote(`Anon note sent successfully via ${successfulRelays}/${selectedRelays.length} relays! <a href="${eventLink}" target="_blank">View Event</a>`, 'success');
                        noteInput.value = '';

                        // Update the last submit time in localStorage only on success
                        localStorage.setItem(localStorageKey, currentTime);

                        // Renew subscriptions to include the new event ID
                        renewReplySubscriptions();
                    }
                }
            } catch (error) {
                console.error('Failed to send note:', error);
                showNote('Failed to send anon note. Please try again.', 'error');
            } finally {
                // Reset the form state (hide spinner, enable button)
                resetFormState();
            }
        } catch (error) {
            console.error('Error in form submission process:', error);
            showNote('An unexpected error occurred. Please try again.', 'error');
            resetFormState();
        }
    });

    function resetFormState() {
        spinner.style.display = 'none';
        submitButton.disabled = false;
    }

    function showNote(note, type) {
        statusNote.innerHTML = note;
        statusNote.className = `note ${type}`;
        statusNote.style.display = note ? 'block' : 'none';
    }

    async function sendNoteToRelay(relayUrl, event) {
        try {
            const relay = new NostrTools.Relay(relayUrl);
            await relay.connect();
            await relay.publish(event);
            relay.close();
            return { success: true, relayUrl };
        } catch (error) {
            console.error(`Failed to connect or publish to relay: ${relayUrl}`, error);
            return { success: false, relayUrl };
        }
    }

    // Helper function to convert image and video URLs to <img> and <video> tags
    function convertMediaUrlsToElements(content) {
        const imageRegex = /(https?:\/\/\S+\.(?:png|jpg|jpeg|gif|bmp|webp|svg|tiff))/gi;
        const videoRegex = /(https?:\/\/\S+\.(?:mp4|webm|ogg))/gi;

        // Replace image URLs with <img> tags
        content = content.replace(imageRegex, (url) => {
            return `<img src="${url}" alt="image" style="max-width: 100%; height: auto; display: block; margin: 10px 0;">`;
        });

        // Replace video URLs with <video> tags
        content = content.replace(videoRegex, (url) => {
            return `<video controls style="max-width: 100%; height: auto; display: block; margin: 10px 0;">
                    <source src="${url}" type="video/mp4">
                    Your browser does not support the video tag.
                </video>`;
        });

        return content;
    }

    function createTimelineItem(event) {
        const timelineItem = document.createElement('div');
        timelineItem.className = 'timeline-item';

        const authorHex = event.pubkey;

        // Get the author's display name and avatar
        const { name: authorName, avatar: authorAvatar } = getProfile(authorHex);

        // Convert the Unix timestamp to a human-readable format
        const timestamp = new Date(event.created_at * 1000).toLocaleString();

        // Convert image URLs in the content to <img> tags
        const contentWithImages = convertMediaUrlsToElements(event.content);

        timelineItem.innerHTML = `
<div class="timeline-header">
    <img src="${authorAvatar}" alt="${authorName}'s avatar" class="avatar">
    <span class="author" data-pubkey="${authorHex}">${authorName}</span>
    <span class="timestamp">${timestamp}</span>
</div>
<p>${contentWithImages}</p>
<span class="reply-icon" data-note-id="${event.id}">↩️</span>
`;

        const replyIcon = timelineItem.querySelector('.reply-icon');
        replyIcon.addEventListener('click', () => {
            handleReplyIconClick(timelineItem, event.id);
        });

        const authorNameElement = timelineItem.querySelector('.author');
        authorNameElement.addEventListener('click', () => {
            openProfileModal(authorHex);
        });

        const avatarElement = timelineItem.querySelector('.avatar');
        avatarElement.addEventListener('click', () => {
            openProfileModal(authorHex);
        });

        return timelineItem;
    }

    function createReplyItem(event) {
        const replyItem = document.createElement('div');
        replyItem.className = 'reply-item';

        const authorHex = event.pubkey;

        // Get the author's display name and avatar
        const { name: authorName, avatar: authorAvatar } = getProfile(authorHex);

        // Convert the Unix timestamp to a human-readable format
        const timestamp = new Date(event.created_at * 1000).toLocaleString();

        // Convert image URLs in the content to <img> tags
        const contentWithImages = convertMediaUrlsToElements(event.content);

        replyItem.innerHTML = `
<div class="timeline-header">
    <img src="${authorAvatar}" alt="${authorName}'s avatar" class="avatar">
    <span class="author" data-pubkey="${authorHex}">${authorName}</span>
    <span class="timestamp">${timestamp}</span>
</div>
<p>${contentWithImages}</p>
<span class="reply-icon" data-note-id="${event.id}">↩️</span>
`;

        const replyIcon = replyItem.querySelector('.reply-icon');
        replyIcon.addEventListener('click', () => {
            handleReplyIconClick(replyItem, event.id);
        });

        const authorNameElement = replyItem.querySelector('.author');
        authorNameElement.addEventListener('click', () => {
            openProfileModal(authorHex);
        });

        const avatarElement = replyItem.querySelector('.avatar');
        avatarElement.addEventListener('click', () => {
            openProfileModal(authorHex);
        });

        return replyItem;
    }

    function handleReplyIconClick(timelineItem, eventId) {
        // Check if a reply textarea already exists
        let replyTextarea = timelineItem.querySelector('.reply-textarea');
        let sendReplyButton = timelineItem.querySelector('.send-reply-button');
        let replyForm = timelineItem.querySelector('.reply-form');

        if (!replyTextarea) {
            // Create a new reply form with textarea, checkboxes, and button
            replyForm = document.createElement('div');
            replyForm.className = 'reply-form';

            replyTextarea = document.createElement('textarea');
            replyTextarea.className = 'reply-textarea';
            replyTextarea.rows = 4;
            replyTextarea.placeholder = 'Write your reply...';

            sendReplyButton = document.createElement('button');
            sendReplyButton.className = 'send-reply-button';
            sendReplyButton.textContent = 'Send Reply';

            // Create checkboxes for reply options with tooltips
            const replyOptions = document.createElement('div');
            replyOptions.className = 'checkbox-group';

            replyOptions.innerHTML = `
                <div class="checkbox-container">
                    <input type="checkbox" class="reply-chain-checkbox">
                    <label for="replyChain">Reply chain</label>
                    <div class="tooltip">ℹ️
                        <span class="tooltiptext">Enable this to link your notes as replies in a threaded conversation, maintaining the context within a linked chain of notes.</span>
                    </div>
                </div>
                <div class="checkbox-container">
                    <input type="checkbox" class="relay-hop-checkbox">
                    <label for="relayHop">Relay hop</label>
                    <div class="tooltip">ℹ️
                        <span class="tooltiptext">Relay hopping adds obfuscation by spreading notes across different relays randomly, making it harder for any single relay to correlate and track the notes.</span>
                    </div>
                </div>
                <div class="checkbox-container">
                    <input type="checkbox" class="tor-relays-checkbox">
                    <label for="torRelays">Tor relays</label>
                    <div class="tooltip">ℹ️
                        <span class="tooltiptext">Use only relays behind onion services for added anonymity.</span>
                    </div>
                </div>
            `;

            // Append the textarea, checkboxes, and button to the reply form
            replyForm.appendChild(replyTextarea);
            replyForm.appendChild(replyOptions);
            replyForm.appendChild(sendReplyButton);

            // Append the reply form to the timeline item
            timelineItem.appendChild(replyForm);

            // Add event listener to the send button
            sendReplyButton.addEventListener('click', () => {
                sendReply(replyTextarea.value, eventId, timelineItem, replyForm);
            });
        } else {
            // Toggle the visibility of the existing reply form
            const isHidden = replyForm.style.display === 'none';
            replyForm.style.display = isHidden ? 'block' : 'none';
        }
    }

    async function sendReply(content, parentId, timelineItem, replyForm) {
        const replyStatusNote = replyForm.querySelector('.note') || document.createElement('div');
        replyStatusNote.className = 'note';
        replyStatusNote.style.display = 'none';
        replyForm.appendChild(replyStatusNote);

        const sendReplyButton = replyForm.querySelector('.send-reply-button');
        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        sendReplyButton.appendChild(spinner);

        try {
            const currentTime = Math.floor(Date.now() / 1000);
            const lastSubmitTime = parseInt(localStorage.getItem(localStorageKey), 10) || 0;
            const timeSinceLastSubmit = currentTime - lastSubmitTime;

            if (timeSinceLastSubmit < rateLimitSeconds) {
                const timeLeft = rateLimitSeconds - timeSinceLastSubmit;
                showReplyNote(`Please wait ${timeLeft} second(s) before submitting again.`, 'warning', replyStatusNote);
                return;
            }

            // Show spinner and disable the button
            spinner.style.display = 'inline-block';
            sendReplyButton.disabled = true;

            // Generate a new key pair for the reply
            const sk = NostrTools.generateSecretKey();
            const pubKey = NostrTools.getPublicKey(sk);

            const tags = [["e", parentId, "", "reply"]]; // Tag the reply to the parent event

            const replyChainChecked = replyForm.querySelector('.reply-chain-checkbox').checked;
            const relayHopChecked = replyForm.querySelector('.relay-hop-checkbox').checked;
            const torRelaysChecked = replyForm.querySelector('.tor-relays-checkbox').checked;

            // If reply chain is enabled and there's a last event ID, add it as a reply
            if (replyChainChecked && lastEventId) {
                tags.push(["e", lastEventId, "", "reply"]);
                if (rootEventId && !tags.some(tag => tag[1] === rootEventId)) {
                    tags.unshift(["e", rootEventId, "", "root"]);
                }
            }

            const eventTemplate = {
                kind: 1,
                pubkey: pubKey,
                created_at: Math.floor(Date.now() / 1000),
                tags: tags,
                content: content
            };

            console.log('Reply Event Template:', eventTemplate);

            // Finalize the event (assigns the event ID, pubkey, and signs it)
            const signedEvent = NostrTools.finalizeEvent(eventTemplate, sk);
            const replyEventId = signedEvent.id;

            console.log('Signed Reply Event:', signedEvent);

            try {
                let selectedRelays;

                if (torRelaysChecked) {
                    // Use Tor relays if the checkbox is checked
                    selectedRelays = torRelays;
                } else {
                    // Otherwise, use default relays
                    selectedRelays = defaultRelays;
                }

                let relaySuccess = false;

                if (relayHopChecked) {
                    // If relay hop is checked, randomly select a single relay
                    let availableRelays = [...selectedRelays];

                    while (!relaySuccess && availableRelays.length > 0) {
                        const randomIndex = Math.floor(Math.random() * availableRelays.length);
                        const randomRelay = availableRelays[randomIndex];

                        const relayResult = await sendNoteToRelay(randomRelay, signedEvent);

                        if (relayResult.success) {
                            relaySuccess = true;
                            const eventLink = `https://njump.me/${replyEventId}`;
                            showReplyNote(`Reply sent successfully via relay hop! <a href="${eventLink}" target="_blank">View Event</a>`, 'success', replyStatusNote);
                            timelineItem.querySelector('.reply-textarea').value = '';

                            // Save the event ID in localStorage
                            saveEventId(replyEventId);

                            // Update the last submit time in localStorage only on success
                            localStorage.setItem(localStorageKey, currentTime);

                            // Renew subscriptions to include the new event ID
                            renewReplySubscriptions();
                        } else {
                            // Remove the failed relay from the list
                            availableRelays.splice(randomIndex, 1);
                            console.warn(`Relay hop failed for relay: ${randomRelay}. Trying another relay...`);
                        }
                    }

                    if (!relaySuccess) {
                        showReplyNote('Relay hopping failed for all relays. Please try again later.', 'error', replyStatusNote);
                    }

                } else {
                    // Otherwise, publish to all selected relays
                    const relayResults = await Promise.all(
                        selectedRelays.map(relayUrl => sendNoteToRelay(relayUrl, signedEvent))
                    );

                    const successfulRelays = relayResults.filter(result => result.success).length;

                    if (successfulRelays === 0) {
                        // If no relays were successful
                        showReplyNote('No relays available. Please try again later.', 'error', replyStatusNote);
                    } else {
                        const eventLink = `https://njump.me/${replyEventId}`;
                        showReplyNote(`Reply sent successfully via ${successfulRelays}/${selectedRelays.length} relays! <a href="${eventLink}" target="_blank">View Event</a>`, 'success', replyStatusNote);
                        timelineItem.querySelector('.reply-textarea').value = '';

                        // Save the event ID in localStorage
                        saveEventId(replyEventId);

                        // Update the last submit time in localStorage only on success
                        localStorage.setItem(localStorageKey, currentTime);

                        // Renew subscriptions to include the new event ID
                        renewReplySubscriptions();
                    }
                }
            } catch (error) {
                console.error('Failed to send reply:', error);
                showReplyNote('Failed to send reply. Please try again.', 'error', replyStatusNote);
            } finally {
                // Hide the spinner and enable the button
                spinner.style.display = 'none';
                sendReplyButton.disabled = false;
            }
        } catch (error) {
            console.error('Error in reply submission process:', error);
            showReplyNote('An unexpected error occurred. Please try again.', 'error', replyStatusNote);
            // Hide the spinner and enable the button
            spinner.style.display = 'none';
            sendReplyButton.disabled = false;
        }
    }

    function showReplyNote(note, type, replyStatusNote) {
        replyStatusNote.innerHTML = note;
        replyStatusNote.className = `note ${type}`;
        replyStatusNote.style.display = note ? 'block' : 'none';
    }

    function subscribeToRelay(relayUrl) {
        if (wsRelays[relayUrl]) {
            console.log(`Already subscribed to ${relayUrl}`);
            return;
        }

        const ws = new WebSocket(relayUrl);
        wsRelays[relayUrl] = ws;

        ws.onopen = () => {
            console.log(`Connected to relay: ${relayUrl}`);

            // Send a REQ message to subscribe to text notes (kind 1) with a limit of 100 events
            const subscriptionId = generateRandomHex(32);
            const reqMessage = JSON.stringify([
                "REQ",
                subscriptionId,
                { kinds: [1], limit: 100 } // Add the limit filter here
            ]);
            ws.send(reqMessage);
            console.log(`Subscribed to relay ${relayUrl} with message: ${reqMessage}`);

            // Subscribe to kind 0 events to get display names and avatars
            const profileReqMessage = JSON.stringify([
                "REQ",
                generateRandomHex(32),
                { kinds: [0] }
            ]);
            ws.send(profileReqMessage);
            console.log(`Subscribed to relay ${relayUrl} for user profiles with message: ${profileReqMessage}`);
        };

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg[0] === "EVENT") {
                const nostrEvent = msg[2];
                if (nostrEvent.kind === 0) {
                    // Handle kind 0 events to cache display names and avatars
                    cacheProfile(nostrEvent);
                } else if (!seenEventIds.has(nostrEvent.id)) {
                    seenEventIds.add(nostrEvent.id);
                    const newTimelineItem = createTimelineItem(nostrEvent);

                    timelineFeed.prepend(newTimelineItem);
                }
            }
        };

        ws.onerror = (error) => {
            console.error(`Error with relay ${relayUrl}:`, error);
        };

        ws.onclose = () => {
            console.log(`Disconnected from relay: ${relayUrl}`);
            delete wsRelays[relayUrl];
        };
    }

    function cacheProfile(event) {
        const pubkey = event.pubkey;
        const profile = JSON.parse(event.content);

        profileCache[pubkey] = {
            name: profile.name || `${pubkey.slice(0, 6)}...${pubkey.slice(-4)}`,
            avatar: profile.picture || generatePixelArtAvatar(pubkey), // Generate avatar if none exists
            banner: profile.banner || './images/anon-banner.png', // Fallback banner image
            nip05: profile.nip05 || '',
            about: profile.about || '',
            lnurl: profile.lud16 || profile.lud06 || ''
        };
    }

    function getProfile(pubkey) {
        if (profileCache[pubkey]) {
            return profileCache[pubkey];
        } else {
            // Return a default profile if not cached
            return {
                name: `${pubkey.slice(0, 6)}...${pubkey.slice(-4)}`,
                avatar: generatePixelArtAvatar(pubkey),
                banner: './images/anon-banner.png', // Fallback banner image
                nip05: '',
                about: '',
                lnurl: ''
            };
        }
    }

    function generatePixelArtAvatar(seed) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const size = 8;
        const scale = 12;
        const avatarSize = 40;
        const hash = hashString(seed);

        canvas.width = avatarSize;
        canvas.height = avatarSize;

        // Apply a random background color
        const backgroundColor = getRandomBackgroundColor(hash);
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(0, 0, avatarSize, avatarSize);

        // Generate the 8x8 pattern, mirroring the left half to the right
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size / 2; x++) {
                const isFilled = hash.charCodeAt((y * size) + x) % 2 === 0;
                ctx.fillStyle = isFilled ? getRandomColor(hash, x, y) : backgroundColor;
                ctx.fillRect(x * scale, y * scale, scale, scale);
                ctx.fillRect((size - x - 1) * scale, y * scale, scale, scale);
            }
        }

        return canvas.toDataURL();
    }

    function getRandomBackgroundColor(hash) {
        const r = (hash.charCodeAt(0) * 31) % 255;
        const g = (hash.charCodeAt(1) * 31) % 255;
        const b = (hash.charCodeAt(2) * 31) % 255;
        return `rgb(${r}, ${g}, ${b})`;
    }

    function hashString(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0;
        }
        return hash.toString();
    }

    function getRandomColor(hash, x, y) {
        const r = (hash.charCodeAt((x + y) % hash.length) * 31) % 255;
        const g = (hash.charCodeAt((y + 1) % hash.length) * 31) % 255;
        const b = (hash.charCodeAt((x + 2) % hash.length) * 31) % 255;
        return `rgb(${r}, ${g}, ${b})`;
    }

    function openProfileModal(pubkey) {
        const profile = getProfile(pubkey);

        profileBanner.src = profile.banner;
        profileAvatar.src = profile.avatar;
        profileName.textContent = profile.name;
        profileNip05.textContent = profile.nip05 ? `NIP-05: ${profile.nip05}` : '';
        profileAbout.textContent = profile.about ? `About: ${profile.about}` : '';
        profileLnurl.textContent = profile.lnurl ? `⚡ ${profile.lnurl}` : '';

        // Clear previous notes
        profileFeed.innerHTML = '';

        // Fetch the user's notes and populate the profile feed
        fetchUserNotes(pubkey);

        profileModal.style.display = 'flex';
    }

    function closeProfileModal() {
        profileModal.style.display = 'none';
    }

    closeModal.addEventListener('click', closeProfileModal);

    // Close the modal when clicking outside of the modal content
    profileModal.addEventListener('click', (event) => {
        if (event.target === profileModal) {
            closeProfileModal();
        }
    });

    function fetchUserNotes(pubkey) {
        const userRelays = [...defaultRelays];
        const subscriptionId = generateRandomHex(32);
        const aggregatedEvents = new Map(); // To store unique events by their ID

        userRelays.forEach(relayUrl => {
            const ws = new WebSocket(relayUrl);
            let isResolved = false; // Track if the connection has been established

            ws.onopen = () => {
                isResolved = true;
                console.log(`Fetching user notes from relay: ${relayUrl}`);

                const reqMessage = JSON.stringify([
                    "REQ",
                    subscriptionId,
                    { kinds: [1], authors: [pubkey], limit: 50 }
                ]);
                ws.send(reqMessage);
            };

            ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg[0] === "EVENT") {
                    const nostrEvent = msg[2];
                    // Deduplicate by event ID
                    if (!aggregatedEvents.has(nostrEvent.id)) {
                        aggregatedEvents.set(nostrEvent.id, nostrEvent);
                        insertSortedEvent(nostrEvent);
                    }
                }
            };

            ws.onerror = (error) => {
                console.error(`Error fetching user notes from relay ${relayUrl}:`, error);
            };

            ws.onclose = () => {
                console.log(`Closed connection to relay: ${relayUrl}`);
            };
        });

        // Function to insert events in real-time, keeping the feed sorted
        function insertSortedEvent(event) {
            const noteItem = createTimelineItem(event);
            const timestamp = event.created_at;

            // Find the correct position to insert the new event
            let inserted = false;
            for (let i = 0; i < profileFeed.children.length; i++) {
                const existingTimestamp = parseInt(profileFeed.children[i].getAttribute('data-timestamp'), 10);
                if (timestamp > existingTimestamp) {
                    profileFeed.insertBefore(noteItem, profileFeed.children[i]);
                    inserted = true;
                    break;
                }
            }

            // If no position is found, append to the end
            if (!inserted) {
                profileFeed.appendChild(noteItem);
            }
        }
    }

    function subscribeToRepliesInitialLoad(relayUrl, eventIds) {
        const ws = new WebSocket(relayUrl);
        wsRelays[relayUrl] = ws;

        ws.onopen = () => {
            console.log(`Connected to relay for replies: ${relayUrl}`);
            sendReplySubscription(ws, eventIds);
        };

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg[0] === "EVENT") {
                const nostrEvent = msg[2];
                if (!seenEventIds.has(nostrEvent.id)) {
                    seenEventIds.add(nostrEvent.id);
                    const newReplyItem = createReplyItem(nostrEvent);

                    // Append the new reply to the bottom of the replies feed
                    repliesFeed.append(newReplyItem);
                }
            }
        };

        ws.onerror = (error) => {
            console.error(`Error with relay ${relayUrl} for replies:`, error);
        };

        ws.onclose = () => {
            console.log(`Disconnected from relay: ${relayUrl}`);
            // Reconnect to maintain the subscription for real-time updates
            setTimeout(() => {
                subscribeToRepliesInitialLoad(relayUrl, eventIds);
            }, 3000); // Reconnect after 3 seconds
        };
    }

    function subscribeToRepliesUpdate(relayUrl, eventIds) {
        if (wsRelays[relayUrl]) {
            console.log(`Already subscribed to ${relayUrl} for replies`);

            // Ensure the WebSocket is open before sending the request
            if (wsRelays[relayUrl].readyState === WebSocket.OPEN) {
                sendReplySubscription(wsRelays[relayUrl], eventIds);
            } else if (wsRelays[relayUrl].readyState === WebSocket.CONNECTING) {
                // If the WebSocket is still connecting, wait until it's open
                wsRelays[relayUrl].addEventListener('open', () => {
                    sendReplySubscription(wsRelays[relayUrl], eventIds);
                }, { once: true });
            }
            return;
        }

        console.log(`WebSocket not connected to ${relayUrl}. Connecting...`);

        const ws = new WebSocket(relayUrl);
        wsRelays[relayUrl] = ws;

        ws.onopen = () => {
            console.log(`Connected to relay for replies: ${relayUrl}`);
            sendReplySubscription(ws, eventIds);
        };

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg[0] === "EVENT") {
                const nostrEvent = msg[2];
                if (!seenEventIds.has(nostrEvent.id)) {
                    seenEventIds.add(nostrEvent.id);
                    const newReplyItem = createReplyItem(nostrEvent);

                    // Append the new reply to the bottom of the replies feed
                    repliesFeed.append(newReplyItem);
                }
            }
        };

        ws.onerror = (error) => {
            console.error(`Error with relay ${relayUrl} for replies:`, error);
        };

        ws.onclose = () => {
            console.log(`Disconnected from relay: ${relayUrl}`);
            // Reconnect to maintain the subscription for real-time updates
            setTimeout(() => {
                subscribeToRepliesUpdate(relayUrl, eventIds);
            }, 3000); // Reconnect after 3 seconds
        };
    }

    function sendReplySubscription(ws, eventIds) {
        const subscriptionId = generateRandomHex(32);
        const reqMessage = JSON.stringify([
            "REQ",
            subscriptionId,
            {
                kinds: [1],
                '#e': eventIds,
                limit: 100
            }
        ]);

        // Send the REQ message to the WebSocket
        ws.send(reqMessage);

        // Log after sending the message
        console.log(`Updated subscription to relay for replies with message: ${reqMessage}`);
    }

    function fetchTimeline() {
        for (const relayUrl of defaultRelays) {
            subscribeToRelay(relayUrl); // Prepend items to the top
        }
    }

    function fetchReplies() {
        const eventIds = getSavedEventIds();
        if (eventIds.length === 0) {
            console.log('No event IDs found to fetch replies for.');
            return;
        }

        for (const relayUrl of defaultRelays) {
            subscribeToRepliesInitialLoad(relayUrl, eventIds);
        }
    }

    // Save event IDs in localStorage
    function saveEventId(eventId) {
        let eventIds = JSON.parse(localStorage.getItem(eventIdsStorageKey)) || [];
        eventIds.push(eventId);
        localStorage.setItem(eventIdsStorageKey, JSON.stringify(eventIds));
    }

    // Get saved event IDs from localStorage
    function getSavedEventIds() {
        return JSON.parse(localStorage.getItem(eventIdsStorageKey)) || [];
    }

    // Renew subscriptions to include newly saved event IDs
    function renewReplySubscriptions() {
        const eventIds = getSavedEventIds();
        if (eventIds.length === 0) return;

        // Close existing connections to relays and reopen them
        for (const relayUrl of defaultRelays) {
            if (wsRelays[relayUrl]) {
                wsRelays[relayUrl].close();
            }
            subscribeToRepliesUpdate(relayUrl, eventIds);
        }
    }

    // Fetch the timeline and replies on page load
    fetchTimeline();
    fetchReplies();
});

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js')
        .then(registration => {
            console.log('Service Worker registered with scope:', registration.scope);
        })
        .catch(error => {
            console.log('Service Worker registration failed:', error);
        });
}