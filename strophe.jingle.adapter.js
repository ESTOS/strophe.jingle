// mozilla chrome compat layer -- very similar to adapter.js
function setupRTC() {
    var RTC = null;
    if (navigator.mozGetUserMedia && mozRTCPeerConnection) {
        console.log('This appears to be Firefox');
        var ua = navigator.userAgent.split(' '),
                isnightly = false;
        try {
            var ver = ua.pop(),
                    build = ua.pop().split('/').pop();

            if (parseFloat(ver.split('/')[1]) > 21.0) {
                isnightly = true;
            }
        } catch (e) {
            console.error('uhm...');
        }
        if (isnightly) {
            RTC = {
                peerconnection: mozRTCPeerConnection,
                browser: 'firefox',
                getUserMedia: navigator.mozGetUserMedia.bind(navigator),
                attachMediaStream: function(element, stream) {
                    element[0].mozSrcObject = stream;
                    element[0].play();
                },
                pc_constraints: {}
            };
            MediaStream.prototype.getVideoTracks = function() { return []; };
            MediaStream.prototype.getAudioTracks = function() { return []; };
            RTCSessionDescription = mozRTCSessionDescription;
            RTCIceCandidate = mozRTCIceCandidate;
        }
    } else if (navigator.webkitGetUserMedia) {
        console.log('This appears to be Chrome');
        RTC = {
            peerconnection: webkitRTCPeerConnection,
            browser: 'chrome',
            getUserMedia: navigator.webkitGetUserMedia.bind(navigator),
            attachMediaStream: function(element, stream) {
                element.attr('src', webkitURL.createObjectURL(stream));
            },
//            pc_constraints: {} // FIVE-182
            pc_constraints: {'optional': [{'DtlsSrtpKeyAgreement': 'true'}]} // enable dtls support in canary
        };
        if (navigator.userAgent.indexOf('Android') != -1) {
            RTC.pc_constraints = {}; // disable DTLS on Android
        }
        if (!webkitMediaStream.prototype.getVideoTracks) {
            webkitMediaStream.prototype.getVideoTracks = function()
            { return this.videoTracks; };
        }
        if (!webkitMediaStream.prototype.getAudioTracks) {
            webkitMediaStream.prototype.getAudioTracks = function()
            { return this.audioTracks; };
        }
    }
    if (RTC == null) {
        try { console.log('Browser does not appear to be WebRTC-capable'); } catch (e) { }
    }
    return RTC;
}

function getUserMediaWithConstraints(um, resolution, bandwidth, fps) {

    var constraints = {audio: false, video: false};

    if ($.inArray('video', um) >= 0) {
        constraints.video = true;
    }
    if ($.inArray('audio', um) >= 0) {
        constraints.audio = true;
    }
    if ($.inArray('screen', um) >= 0) {
        constraints.video = {
            "mandatory": {
                "chromeMediaSource": "screen"
            }
        }
    }

    // see https://code.google.com/p/chromium/issues/detail?id=143631#c9 for list of supported resolutions
    switch (resolution) {
        // 16:9 first
        case '720':
        case 'hd':
            constraints.video = {mandatory: {minWidth: 1280, minHeight: 720, minAspectRatio: 1.77}};
            break;
        case '360':
            constraints.video = {mandatory: {minWidth: 640, minHeight: 360, minAspectRatio: 1.77}};
            break;
        case '180':
            constraints.video = {mandatory: {minWidth: 320, minHeight: 180, minAspectRatio: 1.77}};
            break;
            // 4:3
        case '960':
            constraints.video = {mandatory: {minWidth: 960, minHeight: 720}};
            break;
        case '640':
        case 'vga':
            constraints.video = {mandatory: {maxWidth: 640, maxHeight: 480}};
            break;
        case '320':
            constraints.video = {mandatory: {maxWidth: 320, maxHeight: 240}};
            break;
        default:
            if (navigator.userAgent.indexOf('Android') != -1) {
                constraints.video = {mandatory: {maxWidth: 320, maxHeight: 240, maxFrameRate: 15}};
            }
            break;
    }

    if (bandwidth) { // doesn't work currently, see webrtc issue 1846
        constraints.video.optional = [{bandwidth: bandwidth}];
    }
    if (fps) { // for some cameras it might be necessary to request 30fps
        // so they choose 30fps mjpg over 10fps yuy2
        constraints.video.mandatory['minFrameRate'] = fps;
    }
 
    try {
        RTC.getUserMedia(constraints,
                function(stream) {
                    console.log('onUserMediaSuccess');
                    $(document).trigger('mediaready.jingle', [stream]);
                },
                function(error) {
                    console.warn('Failed to get access to local media. Error ', error);
                    $(document).trigger('mediafailure.jingle');
                });
    } catch (e) {
        console.error('GUM failed: ', e);
        $(document).trigger('mediafailure.jingle');
    }
}
