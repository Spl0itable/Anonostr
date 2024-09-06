document.addEventListener("DOMContentLoaded", () => {
    // *************** //
    // ** Constants ** //
    // *************** //

    const defaultRelays = [
        'wss://relay.damus.io',
        'wss://relay.primal.net',
        'wss://relay.nostr.band'
    ];

    const torRelays = [
        'ws://oxtrdevav64z64yb7x6rjg4ntzqjhedm5b5zjqulugknhzr46ny2qbad.onion',
        'ws://2jsnlhfnelig5acq6iacydmzdbdmg7xwunm4xl6qwbvzacw4lwrjmlyd.onion',
        'ws://nostrnetl6yd5whkldj3vqsxyyaq3tkuspy23a3qgx7cdepb4564qgqd.onion'
    ];

    const rateLimitSeconds = 30; // 30-second delay between note sending
    const localStorageKey = 'lastSubmitTime';
    const eventIdsStorageKey = 'submittedEventIds';
    const followingKey = 'followingPubkeys';
    const targetRateLimitStorageKey = 'targetSubmissions';

    // ********************* //
    // ** State variables ** //
    // ********************* //

    const seenEventIds = new Set();
    const seenReplyEventIds = new Set();
    const profileCache = {};
    const profileFetchQueue = {};
    const wsRelays = {};

    let rootEventId = null;
    let lastEventId = null;
    let currentTimeline = 'following'; // Defaults to 'Following'

    // ****************** //
    // ** DOM Elements ** //
    // ****************** //

    const form = document.getElementById('eventForm');
    const noteInput = document.getElementById('note');
    const replyChainCheckbox = document.getElementById('replyChain');
    const relayHopCheckbox = document.getElementById('relayHop');
    const torRelaysCheckbox = document.getElementById('torRelays');
    const submitButton = form.querySelector('button');
    const spinner = submitButton.querySelector('.spinner');
    const relayList = document.getElementById('relayList');
    const searchModal = document.getElementById('searchModal');
    const closeSearchModal = document.getElementById('closeSearchModal');
    const searchResults = document.getElementById('searchResults');
    const profileView = document.getElementById('profileView');
    const backButton = document.getElementById('backButton');
    const modalProfileBanner = document.getElementById('modalProfileBanner');
    const modalProfileAvatar = document.getElementById('modalProfileAvatar');
    const modalProfileName = document.getElementById('modalProfileName');
    const modalProfileNip05 = document.getElementById('modalProfileNip05');
    const modalProfileAbout = document.getElementById('modalProfileAbout');
    const modalProfileLnurl = document.getElementById('modalProfileLnurl');
    const modalProfileFeed = document.getElementById('modalProfileFeed');
    const searchInput = document.getElementById('searchInput');
    const followingToggle = document.getElementById('followingToggle');
    const globalToggle = document.getElementById('globalToggle');
    const modalFollowButton = document.getElementById('modalFollowButton');
    const searchModalFollowButton = document.getElementById('searchModalFollowButton');

    // ****************************** //
    // ** Initialization Functions ** //
    // ****************************** //

    // Function to handle switching timelines
    function switchTimeline(timeline) {
        if (currentTimeline === timeline) return;

        currentTimeline = timeline;

        const followingFeed = document.getElementById('followingFeed');
        const globalFeed = document.getElementById('globalFeed');

        if (timeline === 'following') {
            followingToggle.className = 'toggle-active';
            globalToggle.className = 'toggle-inactive';
            followingFeed.style.display = 'block';
            globalFeed.style.display = 'none';
            // No need to fetch the timeline again, just show the existing one
        } else if (timeline === 'global') {
            followingToggle.className = 'toggle-inactive';
            globalToggle.className = 'toggle-active';
            followingFeed.style.display = 'none';
            globalFeed.style.display = 'block';
            fetchTimeline(); // Continue fetching events for Global
        }
    }

    // Function to update the relay list display
    function updateRelayList() {
        relayList.innerHTML = '';

        let selectedRelays;
        if (torRelaysCheckbox.checked) {
            selectedRelays = torRelays;
        } else {
            selectedRelays = defaultRelays;
        }

        selectedRelays.forEach(relayUrl => {
            const relayItem = document.createElement('li');
            relayItem.textContent = relayUrl;
            relayList.appendChild(relayItem);
        });
    }

    // *********************** //
    // ** Profile Functions ** //
    // *********************** //

    // Profile view in search results
    function openProfileView(pubkey) {
        if (!pubkey) {
            console.error('pubkey is undefined when opening profile view.');
            return;
        }

        const profile = getProfile(pubkey);

        // Set the pubkey as a data attribute on the banner for easy access
        modalProfileBanner.setAttribute('data-pubkey', pubkey); // Ensure this is the correct element

        updateProfileView(profile);
        updateFollowButton(pubkey, searchModalFollowButton);

        modalProfileFeed.innerHTML = '';

        fetchUserNotes(pubkey, modalProfileFeed, false);

        // Switch from search results to profile view
        searchResults.style.display = 'none';
        profileView.style.display = 'block';
        backButton.style.display = 'block';
        searchModalFollowButton.style.display = 'block';
    }

    function updateProfileView(profile) {
        modalProfileBanner.src = profile.banner;
        modalProfileAvatar.src = profile.avatar;
        modalProfileName.textContent = profile.name;
        modalProfileNip05.textContent = profile.nip05 ? `NIP-05: ${profile.nip05}` : '';
        modalProfileAbout.textContent = profile.about ? `About: ${profile.about}` : '';
        modalProfileLnurl.textContent = profile.lnurl ? `⚡ ${profile.lnurl}` : '';
    }

    // Reset the modal to its initial state
    function resetModal() {
        searchResults.style.display = 'none';
        profileView.style.display = 'none';
        backButton.style.display = 'none';
        searchResults.innerHTML = '';
        modalProfileFeed.innerHTML = '';
    }

    // Function to fetch user notes and display them in the profile view
    function fetchUserNotes(pubkey, feedElement, isProfileModal = false) {
        const userRelays = [...defaultRelays];
        const subscriptionId = generateRandomHex(32);
        const aggregatedEvents = new Map();

        userRelays.forEach(relayUrl => {
            const ws = new WebSocket(relayUrl);
            let isResolved = false;

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
                        insertSortedEvent(nostrEvent, feedElement, isProfileModal);
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
        function insertSortedEvent(event, feedElement, isProfileModal) {
            const noteItem = createTimelineItem(event);
            const timestamp = event.created_at;

            // Find the correct position to insert the new event
            let inserted = false;
            for (let i = 0; i < feedElement.children.length; i++) {
                const existingTimestamp = parseInt(feedElement.children[i].getAttribute('data-timestamp'), 10);
                if (timestamp > existingTimestamp) {
                    feedElement.insertBefore(noteItem, feedElement.children[i]);
                    inserted = true;
                    break;
                }
            }

            // If no position is found, append to the end
            if (!inserted) {
                feedElement.appendChild(noteItem);
            }
        }
    }

    // Function to insert a user note into the profile view
    function insertUserNoteInProfileView(event) {
        const noteItem = createTimelineItem(event);
        modalProfileFeed.appendChild(noteItem);
    }

    // Function to fetch user profile (kind 0) and update the cache
    function fetchUserProfile(pubkey, relayUrl, callback) {
        // If the profile is already in cache, use it
        if (profileCache[pubkey]) {
            callback(profileCache[pubkey]);
            return;
        }

        // If a fetch for this pubkey is already in progress, queue the callback
        if (profileFetchQueue[pubkey]) {
            profileFetchQueue[pubkey].push(callback);
            return;
        }

        // Otherwise, start a new fetch and create a queue for this pubkey
        profileFetchQueue[pubkey] = [callback];

        const ws = new WebSocket(relayUrl);

        ws.onopen = () => {
            console.log(`Fetching profile for pubkey: ${pubkey} from relay: ${relayUrl}`);
            const subscriptionId = generateRandomHex(32);
            const reqMessage = JSON.stringify([
                "REQ",
                subscriptionId,
                { kinds: [0], authors: [pubkey] }
            ]);
            ws.send(reqMessage);
        };

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg[0] === "EVENT") {
                const profileEvent = msg[2];
                if (profileEvent.kind === 0) {
                    // Cache the profile data
                    cacheProfile(profileEvent);

                    // Resolve all queued callbacks with the fetched profile data
                    const profile = getProfile(profileEvent.pubkey);
                    profileFetchQueue[pubkey].forEach(cb => cb(profile));
                    delete profileFetchQueue[pubkey];

                    ws.close();
                }
            }
        };

        ws.onerror = (error) => {
            console.error(`Error fetching profile from relay ${relayUrl}:`, error);
            ws.close();
        };

        ws.onclose = () => {
            console.log(`Closed connection to relay after fetching profile: ${relayUrl}`);
        };
    }

    function cacheProfile(event) {
        const pubkey = event.pubkey;
        const profile = JSON.parse(event.content);

        profileCache[pubkey] = {
            name: profile.name || `${pubkey.slice(0, 6)}...${pubkey.slice(-4)}`,
            avatar: profile.picture || generatePixelArtAvatar(pubkey),
            banner: profile.banner || './images/anon-banner.png',
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
                banner: './images/anon-banner.png',
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

        // Generate the 8x8 pattern
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

    function getRandomColor(hash, x, y) {
        const r = (hash.charCodeAt((x + y) % hash.length) * 31) % 255;
        const g = (hash.charCodeAt((y + 1) % hash.length) * 31) % 255;
        const b = (hash.charCodeAt((x + 2) % hash.length) * 31) % 255;
        return `rgb(${r}, ${g}, ${b})`;
    }

    function openProfileModal(pubkey) {
        if (!pubkey) {
            console.error('pubkey is undefined when opening profile modal.');
            return;
        }

        const profile = getProfile(pubkey);

        // Set the pubkey as a data attribute on the banner for easy access
        profileBanner.setAttribute('data-pubkey', pubkey);

        // Update the modal with cached data
        profileBanner.src = profile.banner;
        profileAvatar.src = profile.avatar;
        profileName.textContent = profile.name;
        profileNip05.textContent = profile.nip05 ? `NIP-05: ${profile.nip05}` : '';
        profileAbout.textContent = profile.about ? `About: ${profile.about}` : '';
        profileLnurl.textContent = profile.lnurl ? `⚡ ${profile.lnurl}` : '';

        updateFollowButton(pubkey, modalFollowButton);

        // Clear previous notes
        profileFeed.innerHTML = '';

        // Fetch the user's notes and populate the profile feed
        fetchUserNotes(pubkey, profileFeed, true);

        profileModal.style.display = 'flex';
        modalFollowButton.style.display = 'block'; // Ensure the follow button is visible
    }

    function closeProfileModal() {
        profileModal.style.display = 'none';
    }

    function updateReplyItemWithProfile(replyItem, pubkey) {
        const profile = getProfile(pubkey);

        // Update the author's name and avatar in the reply item
        const authorNameElement = replyItem.querySelector('.author');
        const avatarElement = replyItem.querySelector('.avatar');

        if (authorNameElement) {
            authorNameElement.textContent = profile.name;
        }
        if (avatarElement) {
            avatarElement.src = profile.avatar;
        }
    }

    // Function to update the follow button state
    function updateFollowButton(pubkey, button) {
        const following = getFollowingPubkeys();
        if (following.includes(pubkey)) {
            button.textContent = 'Unfollow';
        } else {
            button.textContent = 'Follow';
        }
    }

    // Function to handle follow/unfollow actions
    function toggleFollow(pubkey, button) {
        if (!pubkey) {
            console.error('Cannot toggle follow state; pubkey is null');
            return;
        }

        let following = getFollowingPubkeys();

        console.log('Current following list before toggle:', following);

        if (following.includes(pubkey)) {
            // Unfollow: Remove the pubkey from the list
            following = following.filter(pk => pk !== pubkey);
            console.log(`Unfollowed ${pubkey}. Updated following list:`, following);
            button.textContent = 'Follow';
        } else {
            // Follow: Add the pubkey to the list
            following.push(pubkey);
            console.log(`Followed ${pubkey}. Updated following list:`, following);
            button.textContent = 'Unfollow';
        }

        // Update the localStorage with the new following list
        localStorage.setItem(followingKey, JSON.stringify(following));
        console.log('Updated localStorage:', localStorage.getItem(followingKey));

        // Refresh the following timeline to include notes from newly followed users
        fetchFollowingTimeline();
    }

    // Get the list of followed pubkeys from localStorage
    function getFollowingPubkeys() {
        const following = JSON.parse(localStorage.getItem(followingKey)) || [];
        console.log('Fetched following list from localStorage:', following);
        return following;
    }

    // ************************ //
    // ** Timeline Functions ** //
    // ************************ //

    // Function to fetch the timeline for followed users
    function fetchFollowingTimeline() {
        const followingFeed = document.getElementById('followingFeed');
        followingFeed.innerHTML = ''; // Clear the existing following timeline
        showSpinner(followingFeed); // Show spinner for following timeline

        // Close and clear existing WebSocket connections
        for (const relayUrl in wsRelays) {
            if (wsRelays[relayUrl]) {
                wsRelays[relayUrl].close();
                delete wsRelays[relayUrl];
            }
        }

        const following = getFollowingPubkeys();
        if (following.length === 0) {
            // Create and insert the "not following anyone" message directly in the following timeline
            const noFollowingMessage = document.createElement('div');
            noFollowingMessage.className = 'no-following-message';
            noFollowingMessage.textContent = 'You are not following anyone yet.';
            followingFeed.appendChild(noFollowingMessage);

            hideSpinner(followingFeed); // Hide the spinner since there's no content to load
            return;
        }

        for (const relayUrl of defaultRelays) {
            const ws = new WebSocket(relayUrl);
            wsRelays[relayUrl] = ws;

            ws.onopen = () => {
                const subscriptionId = generateRandomHex(32);
                const reqMessage = JSON.stringify([
                    "REQ",
                    subscriptionId,
                    { kinds: [1], authors: following, limit: 100 }
                ]);
                ws.send(reqMessage);

                // Subscribe to kind 0 events to get display names and avatars
                const profileReqMessage = JSON.stringify([
                    "REQ",
                    generateRandomHex(32),
                    { kinds: [0], authors: following }
                ]);
                ws.send(profileReqMessage);
            };

            ws.onmessage = (event) => {
                const msg = JSON.parse(event.data);
                if (msg[0] === "EVENT") {
                    const nostrEvent = msg[2];

                    if (nostrEvent.kind === 0) {
                        // Cache the profile data
                        cacheProfile(nostrEvent);

                        // Update any existing timeline items with the new profile data
                        updateTimelineItemsWithProfileData(nostrEvent.pubkey);
                    } else if (nostrEvent.kind === 1 && !seenEventIds.has(nostrEvent.id)) {
                        seenEventIds.add(nostrEvent.id);

                        // Immediately render the timeline item
                        const newTimelineItem = createTimelineItem(nostrEvent);
                        followingFeed.append(newTimelineItem);
                        hideSpinner(followingFeed); // Hide spinner on first message
                    }
                }
            };

            ws.onerror = (error) => {
                console.error(`Error fetching following timeline from relay ${relayUrl}:`, error);
                hideSpinner(followingFeed); // Hide spinner on error
            };

            ws.onclose = () => {
                console.log(`Closed connection to relay: ${relayUrl}`);
                delete wsRelays[relayUrl];
            };
        }
    }

    // Function to fetch the global timeline
    function fetchTimeline() {
        const globalFeed = document.getElementById('globalFeed');
        globalFeed.innerHTML = ''; // Clear the existing global timeline
        showSpinner(globalFeed); // Show spinner for global timeline

        for (const relayUrl of defaultRelays) {
            subscribeToRelayForGlobalFeed(relayUrl);
        }
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

        // Construct the HTML structure
        timelineItem.innerHTML = `
    <div class="timeline-header">
    <img src="${authorAvatar}" alt="${authorName}'s avatar" class="avatar">
    <span class="author" data-pubkey="${authorHex}">${authorName}</span>
    <span class="timestamp">${timestamp}</span>
    </div>
    <p>${contentWithImages}</p>
    <span class="reply-icon" data-note-id="${event.id}">↩️</span>
    `;

        // Add event listener to reply icon
        const replyIcon = timelineItem.querySelector('.reply-icon');
        if (replyIcon) {
            replyIcon.addEventListener('click', () => {
                handleReplyIconClick(timelineItem, event.id);
            });
        }

        // Add event listener to author's name
        const authorNameElement = timelineItem.querySelector('.author');
        if (authorNameElement) {
            authorNameElement.addEventListener('click', () => {
                openProfileModal(authorHex);
            });
        }

        // Add event listener to avatar image
        const avatarElement = timelineItem.querySelector('.avatar');
        if (avatarElement) {
            avatarElement.addEventListener('click', () => {
                openProfileModal(authorHex);
            });
        }

        return timelineItem;
    }

    function createTimelineItemForSearch(event) {
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
        const avatarElement = timelineItem.querySelector('.avatar');

        // Determine which profile modal to open based on the context
        const openProfile = () => {
            if (searchModal.style.display === 'flex') {
                openProfileView(authorHex); // Open profile in the search modal
            } else {
                openProfileModal(authorHex); // Open the regular profile modal
            }
        };

        authorNameElement.addEventListener('click', openProfile);
        avatarElement.addEventListener('click', openProfile);

        return timelineItem;
    }

    // Function to update timeline items with new profile data
    function updateTimelineItemsWithProfileData(pubkey) {
        const profile = getProfile(pubkey);
        const timelineItems = document.querySelectorAll(`.timeline-item .author[data-pubkey="${pubkey}"]`);

        timelineItems.forEach(item => {
            const avatarElement = item.closest('.timeline-header').querySelector('.avatar');
            item.textContent = profile.name;
            avatarElement.src = profile.avatar;
        });
    }

    function subscribeToRelayForGlobalFeed(relayUrl) {
        const ws = new WebSocket(relayUrl);
        wsRelays[relayUrl] = ws;

        ws.onopen = () => {
            console.log(`Connected to relay: ${relayUrl}`);

            // Send a REQ message to subscribe to text notes (kind 1)
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
                    // Cache the profile data as it comes in
                    cacheProfile(nostrEvent);

                    // Update any existing timeline items with the new profile data
                    updateTimelineItemsWithProfileData(nostrEvent.pubkey);
                } else if (nostrEvent.kind === 1 && !seenEventIds.has(nostrEvent.id)) {
                    seenEventIds.add(nostrEvent.id);
                    const newTimelineItem = createTimelineItem(nostrEvent);
                    const globalFeed = document.getElementById('globalFeed');
                    globalFeed.prepend(newTimelineItem);

                    hideSpinner(globalFeed); // Hide spinner after the first message
                }
            }
        };

        ws.onerror = (error) => {
            console.error(`Error with relay ${relayUrl}:`, error);
            const globalFeed = document.getElementById('globalFeed');
            hideSpinner(globalFeed); // Hide spinner on error
        };

        ws.onclose = () => {
            console.log(`Disconnected from relay: ${relayUrl}`);
            delete wsRelays[relayUrl];
        };
    }

    // Function to fetch replies for specific saved event IDs
    function fetchReplies() {
        const repliesFeed = document.getElementById('repliesFeed');
        repliesFeed.innerHTML = ''; // Clear the existing replies feed
        showSpinner(repliesFeed); // Show spinner for replies feed

        const eventIds = getSavedEventIds();
        if (eventIds.length === 0) {
            console.log('No event IDs found to fetch replies for.');
            hideSpinner(repliesFeed); // Hide spinner if no event IDs
            return;
        }

        for (const relayUrl of defaultRelays) {
            subscribeToRepliesInitialLoad(relayUrl, eventIds);
        }
    }

    // ****************************** //
    // ** Reply Handling Functions ** //
    // ****************************** //

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
        const sendReplyButton = replyForm.querySelector('.send-reply-button');
        const spinner = document.createElement('div');
        spinner.className = 'spinner';
        sendReplyButton.appendChild(spinner);

        const replyStatusNote = replyForm.querySelector('.note') || document.createElement('div');
        replyStatusNote.className = 'note';
        replyStatusNote.style.display = 'none';
        replyForm.appendChild(replyStatusNote);

        try {
            const currentTime = Math.floor(Date.now() / 1000);
            const lastSubmitTime = parseInt(localStorage.getItem(localStorageKey), 10) || 0;
            const timeSinceLastSubmit = currentTime - lastSubmitTime;

            if (timeSinceLastSubmit < rateLimitSeconds) {
                const timeLeft = rateLimitSeconds - timeSinceLastSubmit;
                showReplyNote(`Please wait ${timeLeft} second(s) before submitting again.`, 'warning', replyStatusNote);
                resetReplyFormState(spinner, sendReplyButton);
                return;
            }

            spinner.style.display = 'inline-block';
            sendReplyButton.disabled = true;

            // Generate a new key pair for each reply
            const sk = NostrTools.generateSecretKey();
            const pubKey = NostrTools.getPublicKey(sk);

            // Determine the selected relays
            const torRelaysChecked = replyForm.querySelector('.tor-relays-checkbox').checked;
            let selectedRelays;
            if (torRelaysChecked) {
                selectedRelays = torRelays;
            } else {
                selectedRelays = defaultRelays;
            }

            // Generate and send kind 0 event (anon profile)
            const kind0Event = createAnonKind0Event(pubKey, sk);
            let kind0Success = false;

            const replyChainChecked = replyForm.querySelector('.reply-chain-checkbox').checked;
            const relayHopChecked = replyForm.querySelector('.relay-hop-checkbox').checked;

            if (relayHopChecked) {
                kind0Success = await sendNoteToRelayWithHop(kind0Event, selectedRelays);
            } else {
                kind0Success = await sendNoteToRelayDirect(kind0Event, selectedRelays);
            }

            // Proceed only if kind 0 event was sent successfully
            if (!kind0Success) {
                showReplyNote('Failed to send profile data. Please try again.', 'error', replyStatusNote);
                resetReplyFormState(spinner, sendReplyButton);
                return;
            }

            // Generate a hash of the reply content
            const contentHash = hashString(content);

            // Check for duplicate submissions
            let previousSubmissions = JSON.parse(localStorage.getItem('submittedContentHashes')) || [];
            const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;

            // Filter out old submissions (older than 1 hour)
            previousSubmissions = previousSubmissions.filter(entry => entry.timestamp > oneHourAgo);

            // Check if the current content hash is already in the recent submissions
            if (previousSubmissions.some(entry => entry.hash === contentHash)) {
                showReplyNote('Duplicate submission detected. Please modify your reply before resubmitting.', 'warning', replyStatusNote);
                resetReplyFormState(spinner, sendReplyButton);
                return;
            }

            const tags = [["e", parentId, "", "reply"]];
            let targetKeys = [parentId]; // Start with the parent event ID for rate limiting

            if (replyChainChecked && lastEventId) {
                tags.push(["e", lastEventId, "", "reply"]);
                if (rootEventId && !tags.some(tag => tag[1] === rootEventId)) {
                    tags.unshift(["e", rootEventId, "", "root"]);
                    targetKeys.push(rootEventId); // Include the root event ID in rate limiting
                }
            }

            // Handle mentions and hashtags in the reply content
            const nip19Regex = /([a-z]{1,}[1][qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,})/gi;
            const hashtagRegex = /#\w+/g;

            const matches = content.match(nip19Regex);
            if (matches) {
                for (const match of matches) {
                    try {
                        const decoded = NostrTools.nip19.decode(match);
                        const hexKey = decoded.data;

                        if (decoded.type === 'note' || decoded.type === 'npub' || decoded.type === 'nprofile') {
                            tags.push([decoded.type === 'note' ? "e" : "p", hexKey, "", "mention"]);
                            targetKeys.push(hexKey); // Add the mentioned note or pubkey as a target for rate limiting
                        }
                    } catch (error) {
                        console.error('Error decoding NIP-19 identifier:', error);
                    }
                }
            }

            // Handle hashtags
            const hashtags = content.match(hashtagRegex);
            if (hashtags) {
                for (const tag of hashtags) {
                    tags.push(["t", tag.substring(1)]);
                    targetKeys.push(tag.toLowerCase());
                }
            }

            // Apply rate limiting to all target keys
            for (const targetKey of targetKeys) {
                if (!checkAndUpdateRateLimit(targetKey)) {
                    showReplyNote(`You have reached the limit of 10 replies per hour to this note, pubkey, or hashtag. Please try again later.`, 'warning', replyStatusNote);
                    resetReplyFormState(spinner, sendReplyButton);
                    return;
                }
            }

            const eventTemplate = {
                kind: 1,
                pubkey: pubKey,
                created_at: Math.floor(Date.now() / 1000),
                tags: tags,
                content: content
            };

            const signedEvent = NostrTools.finalizeEvent(eventTemplate, sk);
            const replyEventId = signedEvent.id;

            try {
                let relaySuccess = false;

                if (relayHopChecked) {
                    let availableRelays = [...selectedRelays];

                    while (!relaySuccess && availableRelays.length > 0) {
                        const randomIndex = Math.floor(Math.random() * availableRelays.length);
                        const randomRelay = availableRelays[randomIndex];

                        const relayResult = await sendNoteToRelay(randomRelay, signedEvent);

                        if (relayResult.success) {
                            relaySuccess = true;
                            const eventLink = `https://njump.me/${replyEventId}`;
                            showReplyNote(`Anon reply sent successfully via relay hop! <a href="${eventLink}" target="_blank">View Event</a>`, 'success', replyStatusNote);
                            timelineItem.querySelector('.reply-textarea').value = '';

                            // Store the content hash with the current timestamp to prevent duplicate submissions
                            previousSubmissions.push({ hash: contentHash, timestamp: currentTime });
                            localStorage.setItem('submittedContentHashes', JSON.stringify(previousSubmissions));

                            localStorage.setItem(localStorageKey, currentTime);

                            renewReplySubscriptions();
                        } else {
                            availableRelays.splice(randomIndex, 1);
                            console.warn(`Relay hop failed for relay: ${randomRelay}. Trying another relay...`);
                        }
                    }

                    if (!relaySuccess) {
                        showReplyNote('Relay hopping failed for all relays. Please try again later.', 'error', replyStatusNote);
                    }

                } else {
                    const relayResults = await Promise.all(
                        selectedRelays.map(relayUrl => sendNoteToRelay(relayUrl, signedEvent))
                    );

                    const successfulRelays = relayResults.filter(result => result.success).length;

                    if (successfulRelays === 0) {
                        showReplyNote('No relays available. Please try again later.', 'error', replyStatusNote);
                    } else {
                        const eventLink = `https://njump.me/${replyEventId}`;
                        showReplyNote(`Anon reply sent successfully via ${successfulRelays}/${selectedRelays.length} relays! <a href="${eventLink}" target="_blank">View Event</a>`, 'success', replyStatusNote);
                        timelineItem.querySelector('.reply-textarea').value = '';

                        // Store the content hash with the current timestamp to prevent duplicate submissions
                        previousSubmissions.push({ hash: contentHash, timestamp: currentTime });
                        localStorage.setItem('submittedContentHashes', JSON.stringify(previousSubmissions));

                        localStorage.setItem(localStorageKey, currentTime);

                        renewReplySubscriptions();
                    }
                }
            } catch (error) {
                console.error('Failed to send reply:', error);
                showReplyNote('Failed to send anon reply. Please try again.', 'error', replyStatusNote);
            } finally {
                resetReplyFormState(spinner, sendReplyButton);
            }
        } catch (error) {
            console.error('Error in reply submission process:', error);
            showReplyNote('An unexpected error occurred. Please try again.', 'error', replyStatusNote);
            resetReplyFormState(spinner, sendReplyButton);
        }
    }

    function createReplyItem(event) {
        const replyItem = document.createElement('div');
        replyItem.className = 'reply-item';

        const authorHex = event.pubkey;
        const profile = getProfile(authorHex);

        // Convert the Unix timestamp to a human-readable format
        const timestamp = new Date(event.created_at * 1000).toLocaleString();

        // Convert image URLs in the content to <img> tags
        const contentWithImages = convertMediaUrlsToElements(event.content);

        // Initial rendering with placeholder data
        replyItem.innerHTML = `
    <div class="timeline-header">
    <img src="${profile.avatar}" alt="${profile.name}'s avatar" class="avatar">
    <span class="author" data-pubkey="${authorHex}">${profile.name}</span>
    <span class="timestamp">${timestamp}</span>
    </div>
    <p>${contentWithImages}</p>
    <span class="reply-icon" data-note-id="${event.id}">↩️</span>
    `;

        // Add event listener to reply icon
        const replyIcon = replyItem.querySelector('.reply-icon');
        replyIcon.addEventListener('click', () => {
            handleReplyIconClick(replyItem, event.id);
        });

        const authorNameElement = replyItem.querySelector('.author');
        const avatarElement = replyItem.querySelector('.avatar');

        // Add event listeners for profile modal
        authorNameElement.addEventListener('click', () => {
            openProfileModal(authorHex);
        });
        avatarElement.addEventListener('click', () => {
            openProfileModal(authorHex);
        });

        return replyItem;
    }

    // Function to subscribe to replies for specific event IDs
    function subscribeToRepliesInitialLoad(relayUrl, eventIds) {
        const repliesFeed = document.getElementById('repliesFeed');
        const ws = new WebSocket(relayUrl);
        wsRelays[relayUrl] = ws;

        ws.onopen = () => {
            console.log(`Connected to relay for initial replies load: ${relayUrl}`);
            sendReplySubscription(ws, eventIds);
        };

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg[0] === "EVENT") {
                const nostrEvent = msg[2];

                if (!seenReplyEventIds.has(nostrEvent.id)) {
                    seenReplyEventIds.add(nostrEvent.id);
                    console.log('Received new reply event:', nostrEvent);

                    // Create and append the reply item immediately with placeholder data
                    const newReplyItem = createReplyItem(nostrEvent);
                    repliesFeed.append(newReplyItem);

                    // Hide the spinner when the first reply is received
                    hideSpinner(repliesFeed);

                    // Fetch the profile if not cached
                    if (!profileCache[nostrEvent.pubkey]) {
                        fetchUserProfile(nostrEvent.pubkey, relayUrl, (profile) => {
                            profileCache[nostrEvent.pubkey] = profile;
                            // Update the reply item with the fetched profile data
                            updateReplyItemWithProfile(newReplyItem, nostrEvent.pubkey);
                        });
                    }
                }
            }
        };

        ws.onerror = (error) => {
            console.error(`Error with relay ${relayUrl} for replies:`, error);
            hideSpinner(repliesFeed); // Hide spinner on error
        };

        ws.onclose = () => {
            console.log(`WebSocket connection closed for relay: ${relayUrl}`);
            setTimeout(() => {
                console.log(`Reconnecting to relay for initial replies load: ${relayUrl}`);
                subscribeToRepliesInitialLoad(relayUrl, eventIds);
            }, 3000);
        };
    }

    function subscribeToRepliesUpdate(relayUrl, eventIds) {
        const repliesFeed = document.getElementById('repliesFeed');

        if (wsRelays[relayUrl]) {
            console.log(`Already subscribed to ${relayUrl} for replies`);

            if (wsRelays[relayUrl].readyState === WebSocket.OPEN) {
                console.log(`WebSocket is open for relay: ${relayUrl}, sending subscription request.`);
                sendReplySubscription(wsRelays[relayUrl], eventIds);
            } else if (wsRelays[relayUrl].readyState === WebSocket.CONNECTING) {
                console.log(`WebSocket is connecting for relay: ${relayUrl}, adding event listener for open.`);
                wsRelays[relayUrl].addEventListener('open', () => {
                    sendReplySubscription(wsRelays[relayUrl], eventIds);
                }, { once: true });
            }
            return;
        }

        console.log(`WebSocket not connected to ${relayUrl}. Establishing new connection...`);

        const ws = new WebSocket(relayUrl);
        wsRelays[relayUrl] = ws;

        ws.onopen = () => {
            console.log(`Connected to relay for reply updates: ${relayUrl}`);
            sendReplySubscription(ws, eventIds);
        };

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg[0] === "EVENT") {
                const nostrEvent = msg[2];

                if (!seenReplyEventIds.has(nostrEvent.id)) {
                    seenReplyEventIds.add(nostrEvent.id);
                    console.log('Received new reply event:', nostrEvent);

                    // Create and append the reply item immediately with placeholder data
                    const newReplyItem = createReplyItem(nostrEvent);
                    repliesFeed.append(newReplyItem);

                    // Hide the spinner when the first reply is received
                    hideSpinner(repliesFeed);

                    // Fetch the profile if not cached
                    if (!profileCache[nostrEvent.pubkey]) {
                        fetchUserProfile(nostrEvent.pubkey, relayUrl, (profile) => {
                            profileCache[nostrEvent.pubkey] = profile;
                            // Update the reply item with the fetched profile data
                            updateReplyItemWithProfile(newReplyItem, nostrEvent.pubkey);
                        });
                    }
                }
            }
        };

        ws.onerror = (error) => {
            console.error(`Error with relay ${relayUrl} for replies:`, error);
            hideSpinner(repliesFeed); // Hide spinner on error
        };

        ws.onclose = () => {
            console.log(`WebSocket connection closed for relay: ${relayUrl}`);
            setTimeout(() => {
                console.log(`Reconnecting to relay for reply updates: ${relayUrl}`);
                subscribeToRepliesUpdate(relayUrl, eventIds);
            }, 3000);
        };
    }

    // Renew subscriptions to include newly saved event IDs
    function renewReplySubscriptions() {
        const eventIds = getSavedEventIds();
        if (eventIds.length === 0) return;

        console.log('Renewing reply subscriptions for event IDs:', eventIds);

        for (const relayUrl of defaultRelays) {
            if (wsRelays[relayUrl]) {
                // If the WebSocket is in the OPEN state, send the subscription message immediately
                if (wsRelays[relayUrl].readyState === WebSocket.OPEN) {
                    console.log(`WebSocket is open for relay: ${relayUrl}, sending subscription request.`);
                    sendReplySubscription(wsRelays[relayUrl], eventIds);
                }
                // If the WebSocket is still connecting, add a listener to send the subscription once it opens
                else if (wsRelays[relayUrl].readyState === WebSocket.CONNECTING) {
                    console.log(`WebSocket is connecting for relay: ${relayUrl}, adding event listener for open.`);
                    wsRelays[relayUrl].addEventListener('open', () => {
                        sendReplySubscription(wsRelays[relayUrl], eventIds);
                    }, { once: true });
                }
            } else {
                // Establish a new connection if one doesn't exist
                console.log(`WebSocket not connected to ${relayUrl}. Establishing new connection...`);
                subscribeToRepliesUpdate(relayUrl, eventIds);
            }
        }
    }

    // Function to subscribe to replies for specific event IDs
    function sendReplySubscription(ws, eventIds) {
        const subscriptionId = generateRandomHex(32); // Generate a new subscription ID
        const reqMessage = JSON.stringify([
            "REQ",
            subscriptionId,
            {
                kinds: [1],
                '#e': eventIds,
                limit: 100
            }
        ]);

        ws.send(reqMessage);

        console.log(`Sent new REQ message on existing WebSocket: ${reqMessage}`);
    }

    // ******************************** //
    // ** Input Processing Functions ** //
    // ******************************** //

    // Convert image and video URLs to <img> and <video> tags
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

    function generateRandomHex(length) {
        const characters = '0123456789abcdef';
        let result = '';
        for (let i = 0; i < length; i++) {
            const randomIndex = Math.floor(Math.random() * characters.length);
            result += characters[randomIndex];
        }
        return result;
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

    function checkAndUpdateRateLimit(targetKey) {
        if (!targetKey) return true; // If no target, no rate limiting applies

        // Initialize targetSubmissions only if a targetKey is found
        let targetSubmissions = JSON.parse(localStorage.getItem(targetRateLimitStorageKey)) || {};

        // Check if the current target has any submission history
        if (!targetSubmissions[targetKey]) {
            targetSubmissions[targetKey] = [];
        }

        // Filter out submissions that are older than 1 hour
        const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;
        targetSubmissions[targetKey] = targetSubmissions[targetKey].filter(timestamp => timestamp > oneHourAgo);

        // Enforce the rate limit of 10 submissions per hour to the same target
        if (targetSubmissions[targetKey].length >= 10) {
            return false; // Rate limit exceeded
        }

        // Add the current timestamp to the target's submission history
        targetSubmissions[targetKey].push(Math.floor(Date.now() / 1000));

        // Save the updated submission data back to localStorage
        localStorage.setItem(targetRateLimitStorageKey, JSON.stringify(targetSubmissions));

        return true; // Rate limit not exceeded
    }

    function createAnonKind0Event(pubKey, sk) {
        const anonProfile = generateAnonProfile(pubKey);
        const kind0Event = {
            kind: 0,
            pubkey: pubKey,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: JSON.stringify(anonProfile)
        };

        return NostrTools.finalizeEvent(kind0Event, sk);
    }

    function generateAnonProfile(pubKey) {
        // List of existing avatar generators
        const avatarGenerators = [
            `https://robohash.org/${pubKey}.png`, // RoboHash
            `https://ui-avatars.com/api/?name=${encodeURIComponent(pubKey.slice(0, 6))}&background=random` // UI Avatars
        ];

        // Add all available DiceBear avatar styles for PNG format
        const diceBearStyles = [
            'adventurer',
            'adventurer-neutral',
            'big-ears',
            'big-ears-neutral',
            'big-smile',
            'bottts',
            'bottts-neutral',
            'croodles',
            'croodles-neutral',
            'fun-emoji',
            'icons',
            'identicon',
            'lorelei',
            'lorelei-neutral',
            'micah',
            'miniavs',
            'open-peeps',
            'personas',
            'pixel-art',
            'pixel-art-neutral',
            'shapes',
            'thumbs'
        ];

        // Add DiceBear PNG avatars to the avatarGenerators array
        diceBearStyles.forEach(style => {
            avatarGenerators.push(`https://api.dicebear.com/9.x/${style}/png?seed=${pubKey}`);
        });

        // Randomly select an avatar generator
        const anonAvatar = avatarGenerators[Math.floor(Math.random() * avatarGenerators.length)];

        // Generate a random word for display name
        const word = generateRandomWord();
        const anonName = `${capitalizeFirstLetter(word)}`;

        // Generate a completely random sentence for the about section
        const anonAbout = generateRandomSentence();

        return {
            name: anonName,
            picture: anonAvatar,
            about: anonAbout
        };
    }

    // Generate a random syllable
    function generateRandomSyllable() {
        const consonants = "bcdfghjklmnpqrstvwxyz";
        const vowels = "aeiou";
        const randomConsonant = consonants[Math.floor(Math.random() * consonants.length)];
        const randomVowel = vowels[Math.floor(Math.random() * vowels.length)];

        return randomConsonant + randomVowel;
    }

    // Generate a readable random word using syllables
    function generateRandomWord() {
        const syllableCount = Math.floor(Math.random() * 2) + 2; // 2 to 3 syllables
        let word = "";
        for (let i = 0; i < syllableCount; i++) {
            word += generateRandomSyllable();
        }
        return word;
    }

    // Generate a completely random but readable sentence
    function generateRandomSentence() {
        const sentenceLength = Math.floor(Math.random() * 5) + 5; // Random sentence length between 5 and 9 words
        let sentence = "";

        for (let i = 0; i < sentenceLength; i++) {
            const word = generateRandomWord();
            sentence += word + " ";
        }

        // Capitalize the first letter of the sentence and remove the trailing space
        sentence = sentence.trim();
        sentence = capitalizeFirstLetter(sentence);

        // Add a period at the end of the sentence
        return sentence + ".";
    }

    // Helper function to capitalize the first letter of a word
    function capitalizeFirstLetter(string) {
        return string.charAt(0).toUpperCase() + string.slice(1);
    }

    // ********************** //
    // ** Search Functions ** //
    // ********************** //

    function openSearchModal(query) {
        resetModal();
        const searchResults = document.getElementById('searchResults');
        searchResults.innerHTML = ''; // Clear previous search results
        searchResults.style.display = 'block';
        searchModal.style.display = 'flex';
        showSpinner(searchResults); // Show spinner for search results

        for (const relayUrl of defaultRelays) {
            searchRelay(query, relayUrl).then(() => {
                hideSpinner(searchResults); // Hide spinner when search is done
            }).catch(() => {
                hideSpinner(searchResults); // Hide spinner on error
            });
        }
    }

    async function searchRelay(query, relayUrl) {
        const ws = new WebSocket(relayUrl);

        ws.onopen = () => {
            console.log(`Searching for "${query}" on relay: ${relayUrl}`);

            const subscriptionId = generateRandomHex(32);
            const reqMessage = JSON.stringify([
                "REQ",
                subscriptionId,
                {
                    kinds: [0, 1], // Search for both profile and text events
                    search: query,
                    limit: 50
                }
            ]);
            ws.send(reqMessage);
        };

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg[0] === "EVENT") {
                const nostrEvent = msg[2];

                if (nostrEvent.kind === 0) {
                    // Cache the profile data
                    cacheProfile(nostrEvent);

                    // Retrieve the profile data from cache
                    const { name, avatar } = getProfile(nostrEvent.pubkey);

                    // Create and render the profile item
                    const profileItem = document.createElement('div');
                    profileItem.className = 'profile-result';

                    profileItem.innerHTML = `
    <img src="${avatar}" alt="${name}'s avatar" class="avatar">
    <span class="profile-name">${name}</span>
    `;

                    profileItem.addEventListener('click', () => {
                        openProfileView(nostrEvent.pubkey);
                    });

                    searchResults.appendChild(profileItem);
                } else if (nostrEvent.kind === 1) {
                    // Handle kind 1 (text note) events
                    const searchItem = createTimelineItemForSearch(nostrEvent);
                    searchResults.appendChild(searchItem);
                }
            }
        };

        ws.onerror = (error) => {
            console.error(`Error searching relay ${relayUrl}:`, error);
        };

        ws.onclose = () => {
            console.log(`Closed connection to relay: ${relayUrl}`);
        };
    }

    // *********************** //
    // ** Utility Functions ** //
    // *********************** //

    function showSpinner(feedElement) {
        // Check if the feedElement already has a spinner
        let spinner = feedElement.querySelector('.spinner');
        if (!spinner) {
            // Create a new spinner if it doesn't exist
            spinner = document.createElement('div');
            spinner.className = 'spinner';
            spinner.style.position = 'absolute'; // Ensure spinner is positioned absolutely
            spinner.style.marginTop = '50%';
            spinner.style.top = '50%';
            spinner.style.left = '50%';
            spinner.style.transform = 'translate(-50%, -50%)';
            spinner.style.zIndex = '1000'; // Ensure it overlays other content
            feedElement.style.position = 'relative'; // Set the parent to relative if not already
            feedElement.appendChild(spinner); // Append to feed element
        }
        spinner.style.display = 'block';
    }

    function hideSpinner(feedElement) {
        const spinner = feedElement.querySelector('.spinner');
        if (spinner) {
            spinner.style.display = 'none';
        }
    }

    function showNote(note, type, button) {
        let statusNote = button.nextElementSibling;
        if (!statusNote || !statusNote.classList.contains('note')) {
            statusNote = document.createElement('div');
            statusNote.className = 'note';
            button.parentNode.insertBefore(statusNote, button.nextSibling);
        }
        statusNote.innerHTML = note;
        statusNote.className = `note ${type}`;
        statusNote.style.display = note ? 'block' : 'none';
    }

    function resetFormState() {
        spinner.style.display = 'none';
        submitButton.disabled = false;
    }

    function resetReplyFormState(spinner, sendReplyButton) {
        spinner.style.display = 'none';
        sendReplyButton.disabled = false;
    }

    function showReplyNote(note, type, replyStatusNote) {
        replyStatusNote.innerHTML = note;
        replyStatusNote.className = `note ${type}`;
        replyStatusNote.style.display = note ? 'block' : 'none';
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

    // *********************************** //
    // ** Relay Communication Functions ** //
    // *********************************** //

    function subscribeToRelay(relayUrl, following) {
        if (wsRelays[relayUrl] && wsRelays[relayUrl].readyState === WebSocket.OPEN) {
            console.log(`Already subscribed to ${relayUrl}`);
            return;
        }

        wsRelays[relayUrl] = new WebSocket(relayUrl);

        wsRelays[relayUrl].onopen = () => {
            console.log(`Connected to relay: ${relayUrl}`);

            // Send a REQ message to subscribe to text notes (kind 1) with a limit of 100 events
            const subscriptionId = generateRandomHex(32);
            const reqMessage = JSON.stringify([
                "REQ",
                subscriptionId,
                { kinds: [1], authors: following, limit: 100 } // Add the limit filter here
            ]);
            wsRelays[relayUrl].send(reqMessage);

            // Subscribe to kind 0 events to get display names and avatars
            const profileReqMessage = JSON.stringify([
                "REQ",
                generateRandomHex(32),
                { kinds: [0], authors: following }
            ]);
            wsRelays[relayUrl].send(profileReqMessage);
        };

        wsRelays[relayUrl].onmessage = (event) => {
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

        wsRelays[relayUrl].onerror = (error) => {
            console.error(`Error with relay ${relayUrl}:`, error);
        };

        wsRelays[relayUrl].onclose = () => {
            console.log(`Disconnected from relay: ${relayUrl}`);
            delete wsRelays[relayUrl]; // Cleanup on close
        };
    }

    async function sendNoteToRelay(relayUrl, event) {
        return new Promise((resolve) => {
            // Check if we already have an open WebSocket connection to this relay
            if (!wsRelays[relayUrl] || wsRelays[relayUrl].readyState !== WebSocket.OPEN) {
                console.log(`Establishing new connection to relay: ${relayUrl}`);
                wsRelays[relayUrl] = new WebSocket(relayUrl);

                wsRelays[relayUrl].onopen = () => {
                    console.log(`Connected to relay: ${relayUrl}`);
                    wsRelays[relayUrl].send(JSON.stringify(["EVENT", event]));
                    console.log(`Sent event to relay ${relayUrl}:`, event);
                };

                wsRelays[relayUrl].onmessage = (message) => {
                    const response = JSON.parse(message.data);
                    if (response[0] === "OK" && response[1] === event.id) {
                        console.log(`Relay ${relayUrl} accepted event: ${event.id}`);
                        resolve({ success: true, relayUrl });
                    } else {
                        resolve({ success: false, relayUrl });
                    }
                };

                wsRelays[relayUrl].onerror = (error) => {
                    console.error(`Failed to send event to relay ${relayUrl}:`, error);
                    resolve({ success: false, relayUrl });
                };

                wsRelays[relayUrl].onclose = () => {
                    console.log(`Disconnected from relay: ${relayUrl}`);
                    delete wsRelays[relayUrl]; // Cleanup on close
                    resolve({ success: false, relayUrl });
                };
            } else {
                // Reuse the existing open connection
                console.log(`Reusing open connection to relay: ${relayUrl}`);
                wsRelays[relayUrl].send(JSON.stringify(["EVENT", event]));
                console.log(`Sent event to relay ${relayUrl}:`, event);

                wsRelays[relayUrl].onmessage = (message) => {
                    const response = JSON.parse(message.data);
                    if (response[0] === "OK" && response[1] === event.id) {
                        console.log(`Relay ${relayUrl} accepted event: ${event.id}`);
                        resolve({ success: true, relayUrl });
                    } else {
                        resolve({ success: false, relayUrl });
                    }
                };

                wsRelays[relayUrl].onerror = (error) => {
                    console.error(`Failed to send event to relay ${relayUrl}:`, error);
                    resolve({ success: false, relayUrl });
                };

                wsRelays[relayUrl].onclose = () => {
                    console.log(`Disconnected from relay: ${relayUrl}`);
                    delete wsRelays[relayUrl]; // Cleanup on close
                    resolve({ success: false, relayUrl });
                };
            }
        });
    }

    async function sendNoteToRelayWithHop(event, relays) {
        let relaySuccess = false;
        let availableRelays = [...relays];

        while (!relaySuccess && availableRelays.length > 0) {
            const randomIndex = Math.floor(Math.random() * availableRelays.length);
            const randomRelay = availableRelays[randomIndex];

            const relayResult = await sendNoteToRelay(randomRelay, event);

            if (relayResult.success) {
                relaySuccess = true;
            } else {
                availableRelays.splice(randomIndex, 1);
                console.warn(`Relay hop failed for relay: ${randomRelay}. Trying another relay...`);
            }
        }

        return relaySuccess; // Indicate whether any relay succeeded
    }

    async function sendNoteToRelayDirect(event, relays) {
        const relayResults = await Promise.all(
            relays.map(relayUrl => sendNoteToRelay(relayUrl, event))
        );

        const successfulRelays = relayResults.filter(result => result.success).length;

        if (successfulRelays === 0) {
            return false; // Indicate failure if no relays succeeded
        }

        return true; // Indicate success if at least one relay succeeded
    }

    // ********************* //
    // ** Event Listeners ** //
    // ********************* //

    // Event listeners for toggle buttons
    followingToggle.addEventListener('click', () => {
        switchTimeline('following');
    });

    globalToggle.addEventListener('click', () => {
        switchTimeline('global');
    });

    closeSearchModal.addEventListener('click', () => {
        searchModal.style.display = 'none';
        resetModal();
    });

    searchModal.addEventListener('click', (event) => {
        if (event.target === searchModal) {
            searchModal.style.display = 'none';
            resetModal();
        }
    });

    backButton.addEventListener('click', () => {
        profileView.style.display = 'none';
        searchResults.style.display = 'block';
        backButton.style.display = 'none';
    });

    torRelaysCheckbox.addEventListener('change', updateRelayList);
    relayHopCheckbox.addEventListener('change', updateRelayList);
    modalFollowButton.addEventListener('click', () => {
        const pubkey = profileBanner.getAttribute('data-pubkey');
        toggleFollow(pubkey, modalFollowButton);
    });

    searchModalFollowButton.addEventListener('click', () => {
        const pubkey = modalProfileBanner.getAttribute('data-pubkey');
        toggleFollow(pubkey, searchModalFollowButton);
    });

    searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            const query = searchInput.value.trim();
            if (query) {
                openSearchModal(query);
            }
        }
    });

    form.addEventListener('submit', async (event) => {
        event.preventDefault();

        try {
            const currentTime = Math.floor(Date.now() / 1000);
            const lastSubmitTime = parseInt(localStorage.getItem(localStorageKey), 10) || 0;
            const timeSinceLastSubmit = currentTime - lastSubmitTime;

            if (timeSinceLastSubmit < rateLimitSeconds) {
                const timeLeft = rateLimitSeconds - timeSinceLastSubmit;
                showNote(`Please wait ${timeLeft} second(s) before submitting again.`, 'warning', submitButton);
                return;
            }

            // Reset the status note and show the spinner
            showNote('', '', submitButton); // Ensure the note is cleared
            spinner.style.display = 'inline-block';
            submitButton.disabled = true;

            // Generate a new key pair on each submit
            const sk = NostrTools.generateSecretKey();
            const pubKey = NostrTools.getPublicKey(sk);

            let note = noteInput.value.trim();
            if (!note) {
                showNote('Please enter a note.', 'error', submitButton);
                resetFormState();
                return;
            }

            // Generate a hash of the note content
            const contentHash = hashString(note);

            // Check for duplicate submissions
            let previousSubmissions = JSON.parse(localStorage.getItem('submittedContentHashes')) || [];
            const oneHourAgo = Math.floor(Date.now() / 1000) - 3600;

            // Filter out old submissions (older than 1 hour)
            previousSubmissions = previousSubmissions.filter(entry => entry.timestamp > oneHourAgo);

            // Check if the current content hash is already in the recent submissions
            if (previousSubmissions.some(entry => entry.hash === contentHash)) {
                showNote('Duplicate submission detected. Please modify your note before resubmitting.', 'warning', submitButton);
                resetFormState();
                return;
            }

            // Determine the selected relays
            let selectedRelays;
            if (torRelaysCheckbox.checked) {
                selectedRelays = torRelays;
            } else {
                selectedRelays = defaultRelays;
            }

            // Generate and send kind 0 event (anon profile)
            const kind0Event = createAnonKind0Event(pubKey, sk);
            let kind0Success = false;

            if (relayHopCheckbox.checked) {
                kind0Success = await sendNoteToRelayWithHop(kind0Event, selectedRelays);
            } else {
                kind0Success = await sendNoteToRelayDirect(kind0Event, selectedRelays);
            }

            // Proceed only if kind 0 event was sent successfully
            if (!kind0Success) {
                showNote('Failed to send profile data. Please try again.', 'error', submitButton);
                resetFormState();
                return;
            }

            const tags = [];
            const nip19Regex = /([a-z]{1,}[1][qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,})/gi;
            const hashtagRegex = /#\w+/g;

            let isRootSet = false;
            let firstMatchIsNote = false;
            let targetKeys = [];

            // Handle mentions, note references, and hashtags
            const matches = note.match(nip19Regex);
            if (matches) {
                for (const match of matches) {
                    try {
                        const decoded = NostrTools.nip19.decode(match);
                        const hexKey = decoded.data;

                        if (decoded.type === 'note') {
                            if (!isRootSet && note.startsWith(match)) {
                                rootEventId = hexKey;
                                tags.unshift(["e", hexKey, "", "root"]);
                                note = note.replace(match, '').trim();
                                isRootSet = true;
                                firstMatchIsNote = true;
                            } else {
                                tags.push(["e", hexKey, "", "mention"]);
                                note = note.replace(match, `nostr:${match}`);
                            }
                            // Add the event ID to the list of target keys for rate limiting
                            targetKeys.push(hexKey);
                        } else if (decoded.type === 'npub' || decoded.type === 'nprofile') {
                            tags.push(["p", hexKey, "", "mention"]);
                            // Add the pubkey to the list of target keys for rate limiting
                            targetKeys.push(hexKey);
                        }
                    } catch (error) {
                        console.error('Error decoding NIP-19 identifier:', error);
                    }
                }
            }

            // Handle hashtags
            const hashtags = note.match(hashtagRegex);
            if (hashtags) {
                for (const tag of hashtags) {
                    tags.push(["t", tag.substring(1)]);
                    targetKeys.push(tag.toLowerCase()); // Treat hashtag as a target key for rate limiting
                }
            }

            // Check if reply chain is enabled and set the target accordingly
            if (replyChainCheckbox.checked && lastEventId) {
                tags.push(["e", lastEventId, "", "reply"]);
                if (rootEventId && !isRootSet) {
                    tags.unshift(["e", rootEventId, "", "root"]);
                    isRootSet = true;
                    targetKeys.push(rootEventId); // Use rootEventId as one of the targets for rate limiting
                }
            }

            // Apply rate limiting to all target keys
            for (const targetKey of targetKeys) {
                if (!checkAndUpdateRateLimit(targetKey)) {
                    showNote(`You have reached the limit of 10 submissions per hour to this note, pubkey, or hashtag. Please try again later.`, 'warning', submitButton);
                    resetFormState();
                    return;
                }
            }

            const eventTemplate = {
                kind: 1,
                pubkey: pubKey,
                created_at: Math.floor(Date.now() / 1000),
                tags: tags,
                content: note
            };

            const signedEvent = NostrTools.finalizeEvent(eventTemplate, sk);
            lastEventId = signedEvent.id;

            saveEventId(lastEventId);

            if (!rootEventId) {
                rootEventId = lastEventId;
            }

            try {
                let relaySuccess = false;

                if (relayHopCheckbox.checked) {
                    let availableRelays = [...selectedRelays];

                    while (!relaySuccess && availableRelays.length > 0) {
                        const randomIndex = Math.floor(Math.random() * availableRelays.length);
                        const randomRelay = availableRelays[randomIndex];

                        const relayResult = await sendNoteToRelay(randomRelay, signedEvent);

                        if (relayResult.success) {
                            relaySuccess = true;
                            const eventId = signedEvent.id;
                            const eventLink = `https://njump.me/${eventId}`;
                            showNote(`Anon note sent successfully via relay hop! <a href="${eventLink}" target="_blank">View Event</a>`, 'success', submitButton);
                            noteInput.value = '';

                            // Store the content hash with the current timestamp to prevent duplicate submissions
                            previousSubmissions.push({ hash: contentHash, timestamp: currentTime });
                            localStorage.setItem('submittedContentHashes', JSON.stringify(previousSubmissions));

                            localStorage.setItem(localStorageKey, currentTime);

                            renewReplySubscriptions();
                        } else {
                            availableRelays.splice(randomIndex, 1);
                            console.warn(`Relay hop failed for relay: ${randomRelay}. Trying another relay...`);
                        }
                    }

                    if (!relaySuccess) {
                        showNote('Relay hopping failed for all relays. Please try again later.', 'error', submitButton);
                    }

                } else {
                    const relayResults = await Promise.all(
                        selectedRelays.map(relayUrl => sendNoteToRelay(relayUrl, signedEvent))
                    );

                    const successfulRelays = relayResults.filter(result => result.success).length;

                    if (successfulRelays === 0) {
                        showNote('No relays available. Please try again later.', 'error', submitButton);
                    } else {
                        const eventId = signedEvent.id;
                        const eventLink = `https://njump.me/${eventId}`;
                        showNote(`Anon note sent successfully via ${successfulRelays}/${selectedRelays.length} relays! <a href="${eventLink}" target="_blank">View Event</a>`, 'success', submitButton);
                        noteInput.value = '';

                        // Store the content hash with the current timestamp to prevent duplicate submissions
                        previousSubmissions.push({ hash: contentHash, timestamp: currentTime });
                        localStorage.setItem('submittedContentHashes', JSON.stringify(previousSubmissions));

                        localStorage.setItem(localStorageKey, currentTime);

                        renewReplySubscriptions();
                    }
                }
            } catch (error) {
                console.error('Failed to send note:', error);
                showNote('Failed to send anon note. Please try again.', 'error', submitButton);
            } finally {
                resetFormState();
            }
        } catch (error) {
            console.error('Error in form submission process:', error);
            showNote('An unexpected error occurred. Please try again.', 'error', submitButton);
            resetFormState();
        }
    });

    closeModal.addEventListener('click', closeProfileModal);

    // Close the modal when clicking outside of the modal content
    profileModal.addEventListener('click', (event) => {
        if (event.target === profileModal) {
            closeProfileModal();
        }
    });

    // ********************* //
    // ** Initializations ** //
    // ********************* //

    fetchFollowingTimeline();
    if (currentTimeline === 'global') fetchTimeline();
    fetchReplies();
    updateRelayList();
});