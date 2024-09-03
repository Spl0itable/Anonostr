document.addEventListener("DOMContentLoaded", () => {
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
    const eventIdsStorageKey = 'submittedEventIds';
    const seenEventIds = new Set();
    const seenReplyEventIds = new Set();
    const profileCache = {};
    const profileFetchQueue = {};

    let rootEventId = null;
    let lastEventId = null;

    // WebSocket references for managing subscriptions
    const wsRelays = {};

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
    const followingKey = 'followingPubkeys';
    const followingToggle = document.getElementById('followingToggle');
    const globalToggle = document.getElementById('globalToggle');
    const modalFollowButton = document.getElementById('modalFollowButton');
    const searchModalFollowButton = document.getElementById('searchModalFollowButton');

    // Initialize the timeline view
    let currentTimeline = 'following'; // Default to 'Following'

    // Event listeners for toggle buttons
    followingToggle.addEventListener('click', () => {
        switchTimeline('following');
    });

    globalToggle.addEventListener('click', () => {
        switchTimeline('global');
    });

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
            fetchFollowingTimeline();
        } else if (timeline === 'global') {
            followingToggle.className = 'toggle-inactive';
            globalToggle.className = 'toggle-active';
            followingFeed.style.display = 'none';
            globalFeed.style.display = 'block';
            fetchTimeline();
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

        // Refresh the following timeline and re-subscribe to replies
        fetchFollowingTimeline();
        renewReplySubscriptions(); // Ensure replies column is updated
    }

    // Get the list of followed pubkeys from localStorage
    function getFollowingPubkeys() {
        const following = JSON.parse(localStorage.getItem(followingKey)) || [];
        console.log('Fetched following list from localStorage:', following);
        return following;
    }

    // Get the list of followed pubkeys from localStorage
    function getFollowingPubkeys() {
        return JSON.parse(localStorage.getItem(followingKey)) || [];
    }

    // Event listeners for follow buttons
    modalFollowButton.addEventListener('click', () => {
        const pubkey = profileBanner.getAttribute('data-pubkey');
        toggleFollow(pubkey, modalFollowButton);
    });

    searchModalFollowButton.addEventListener('click', () => {
        const pubkey = modalProfileBanner.getAttribute('data-pubkey');
        toggleFollow(pubkey, searchModalFollowButton);
    });

    // Function to fetch the timeline for followed users
    function fetchFollowingTimeline() {
        const followingFeed = document.getElementById('followingFeed');
        followingFeed.innerHTML = ''; // Clear the existing following timeline
        showSpinner(followingFeed); // Show spinner for following timeline

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
            };
        }
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

    searchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            const query = searchInput.value.trim();
            if (query) {
                openSearchModal(query);
            }
        }
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

    // Fetch the initial timeline based on the current view
    if (currentTimeline === 'following') {
        fetchFollowingTimeline();
    } else {
        fetchTimeline();
    }

    // Function to fetch user notes and display them in the profile view
    function fetchUserNotes(pubkey, feedElement, isProfileModal = false) {
        feedElement.innerHTML = ''; // Clear previous notes
        showSpinner(feedElement); // Show spinner for profile feed

        const userRelays = [...defaultRelays];
        const subscriptionId = generateRandomHex(32);
        const aggregatedEvents = new Map();

        userRelays.forEach(relayUrl => {
            const ws = new WebSocket(relayUrl);

            ws.onopen = () => {
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
                    if (!aggregatedEvents.has(nostrEvent.id)) {
                        aggregatedEvents.set(nostrEvent.id, nostrEvent);
                        insertUserNoteInProfileView(nostrEvent);
                        hideSpinner(feedElement); // Hide spinner on first message
                    }
                }
            };

            ws.onerror = (error) => {
                console.error(`Error fetching user notes from relay ${relayUrl}:`, error);
                hideSpinner(feedElement); // Hide spinner on error
            };

            ws.onclose = () => {
                console.log(`Closed connection to relay: ${relayUrl}`);
            };
        });
    }

    // Function to insert a user note into the profile view
    function insertUserNoteInProfileView(event) {
        const noteItem = createTimelineItem(event);
        modalProfileFeed.appendChild(noteItem);
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

    closeModal.addEventListener('click', closeProfileModal);

    // Close the modal when clicking outside of the modal content
    profileModal.addEventListener('click', (event) => {
        if (event.target === profileModal) {
            closeProfileModal();
        }
    });

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

    // Function to fetch the global timeline
    function fetchTimeline() {
        const globalFeed = document.getElementById('globalFeed');
        globalFeed.innerHTML = ''; // Clear the existing global timeline
        showSpinner(globalFeed); // Show spinner for global timeline

        for (const relayUrl of defaultRelays) {
            subscribeToRelayForGlobalFeed(relayUrl);
        }
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
    // Function to fetch replies for specific saved event IDs
    function fetchReplies() {
        const repliesFeed = document.getElementById('repliesFeed');
        repliesFeed.innerHTML = ''; // Clear the existing replies feed
        showSpinner(repliesFeed); // Show spinner for replies feed

        const eventIds = getSavedEventIds();
        if (eventIds.length === 0) {
            console.log('No event IDs found to fetch replies for.');
            hideSpinner(repliesFeed); // Hide spinner if no event IDs
            showNoRepliesMessage(repliesFeed); // Show "No replies yet" message
            return;
        }

        let repliesReceived = false;

        // Function to handle WebSocket closure after all connections are done
        const handleAllSocketsClosed = () => {
            if (!repliesReceived) {
                hideSpinner(repliesFeed); // Ensure spinner is hidden
                showNoRepliesMessage(repliesFeed); // Show "No replies yet" message
            }
        };

        let wsCount = defaultRelays.length;
        for (const relayUrl of defaultRelays) {
            const ws = subscribeToRepliesInitialLoad(relayUrl, eventIds);

            ws.addEventListener('message', () => {
                repliesReceived = true;
            });

            ws.addEventListener('close', () => {
                wsCount -= 1;
                if (wsCount === 0) {
                    handleAllSocketsClosed();
                }
            });

            ws.addEventListener('error', () => {
                wsCount -= 1;
                if (wsCount === 0) {
                    handleAllSocketsClosed();
                }
            });
        }
    }

    // Function to show "No replies yet" message
    function showNoRepliesMessage(repliesFeed) {
        const noRepliesMessage = document.createElement('div');
        noRepliesMessage.className = 'no-replies-message';
        noRepliesMessage.textContent = 'No replies yet.';
        repliesFeed.appendChild(noRepliesMessage);
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

    // Fetch the timeline and replies on page load
    fetchTimeline();
    fetchFollowingTimeline();
    fetchReplies();
});