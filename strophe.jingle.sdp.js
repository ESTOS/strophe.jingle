/* jshint -W117 */
var SDP;

(function($){
// SDP STUFF
SDP = function(sdp) {
    this.media = sdp.split('\r\nm=');
    for (var i = 1; i < this.media.length; i++) {
        this.media[i] = 'm=' + this.media[i];
        if (i != this.media.length - 1) {
            this.media[i] += '\r\n';
        }
    }
    this.session = this.media.shift() + '\r\n';
    this.raw = this.session + this.media.join('');
}

// remove iSAC and CN from SDP
SDP.prototype.mangle = function () {
    var i, j, mline, lines, rtpmap, newdesc;
    for (i = 0; i < this.media.length; i++) {
        lines = this.media[i].split('\r\n');
        lines.pop(); // remove empty last element
        mline = SDPUtil.parse_mline(lines.shift());
        if (mline.media != 'audio')
            continue;
        newdesc = '';
        mline.fmt.length = 0;
        for (j = 0; j < lines.length; j++) {
            if (lines[j].substr(0, 9) == 'a=rtpmap:') {
                rtpmap = SDPUtil.parse_rtpmap(lines[j]);
                if (rtpmap.name == 'CN' || rtpmap.name == 'ISAC')
                    continue;
                mline.fmt.push(rtpmap.id);
                newdesc += lines[j] + '\r\n';
            } else {
                newdesc += lines[j] + '\r\n';
            }
        }
        this.media[i] = SDPUtil.build_mline(mline) + '\r\n';
        this.media[i] += newdesc;
    }
    this.raw = this.session + this.media.join('');
};

// remove lines matching prefix from session section
SDP.prototype.removeSessionLines = function(prefix) {
    var self = this;
    var lines = SDPUtil.find_lines(this.session, prefix);
    lines.forEach(function(line) {
        self.session = self.session.replace(line + '\r\n', '');
    });
    this.raw = this.session + this.media.join('');
    return lines;
}
// remove lines matching prefix from a media section specified by mediaindex
// TODO: non-numeric mediaindex could match mid
SDP.prototype.removeMediaLines = function(mediaindex, prefix) {
    var self = this;
    var lines = SDPUtil.find_lines(this.media[mediaindex], prefix);
    lines.forEach(function(line) {
        self.media[mediaindex] = self.media[mediaindex].replace(line + '\r\n', '');
    });
    this.raw = this.session + this.media.join('');
    return lines;
}

// add content's to a jingle element
SDP.prototype.toJingle = function (elem, thecreator) {
    var i, j, k, mline, ssrc, rtpmap, tmp, line, lines;
    var self = this;
    // new bundle plan
    if (SDPUtil.find_line(this.session, 'a=group:')) {
        lines = SDPUtil.find_lines(this.session, 'a=group:');
        for (i = 0; i < lines.length; i++) {
            tmp = lines[i].split(' ');
            var semantics = tmp.shift().substr(8);
            elem.c('group', {xmlns: 'urn:xmpp:jingle:apps:grouping:0', semantics:semantics});
            for (j = 0; j < tmp.length; j++) {
                elem.c('content', {name: tmp[j]}).up();
            }
            elem.up();
        }
    }
    // old bundle plan, to be removed
    var bundle = [];
    if (SDPUtil.find_line(this.session, 'a=group:BUNDLE')) {
        bundle = SDPUtil.find_line(this.session, 'a=group:BUNDLE ').split(' ');
        bundle.shift();
    }
    for (i = 0; i < this.media.length; i++) {
        mline = SDPUtil.parse_mline(this.media[i].split('\r\n')[0]);
        if (!(mline.media == 'audio' || mline.media == 'video')) {
            continue;
        }
        if (SDPUtil.find_line(this.media[i], 'a=ssrc:')) {
            ssrc = SDPUtil.find_line(this.media[i], 'a=ssrc:').substring(7).split(' ')[0]; // take the first
        } else {
            ssrc = false;
        }

        elem.c('content', {creator: thecreator, name: mline.media});
        if (SDPUtil.find_line(this.media[i], 'a=mid:')) {
            // prefer identifier from a=mid if present
            var mid = SDPUtil.parse_mid(SDPUtil.find_line(this.media[i], 'a=mid:'));
            elem.attrs({ name: mid });

            // old BUNDLE plan, to be removed
            if (bundle.indexOf(mid) != -1) {
                elem.c('bundle', {xmlns: 'http://estos.de/ns/bundle'}).up();
                bundle.splice(bundle.indexOf(mid), 1);
            }
        }
        if (SDPUtil.find_line(this.media[i], 'a=rtpmap:').length) {
            elem.c('description',
                 {xmlns: 'urn:xmpp:jingle:apps:rtp:1',
                  media: mline.media });
            if (ssrc) {
                elem.attrs({ssrc: ssrc});
            }
            for (j = 0; j < mline.fmt.length; j++) {
                rtpmap = SDPUtil.find_line(this.media[i], 'a=rtpmap:' + mline.fmt[j]);
                elem.c('payload-type', SDPUtil.parse_rtpmap(rtpmap));
                // put any 'a=fmtp:' + mline.fmt[j] lines into <param name=foo value=bar/>
                if (SDPUtil.find_line(this.media[i], 'a=fmtp:' + mline.fmt[j])) {
                    tmp = SDPUtil.parse_fmtp(SDPUtil.find_line(this.media[i], 'a=fmtp:' + mline.fmt[j]));
                    for (k = 0; k < tmp.length; k++) {
                        elem.c('parameter', tmp[k]).up();
                    }
                }
                this.RtcpFbToJingle(i, elem, mline.fmt[j]); // XEP-0293 -- map a=rtcp-fb

                elem.up();
            }
            if (SDPUtil.find_line(this.media[i], 'a=crypto:', this.session)) {
                elem.c('encryption', {required: 1});
                var crypto = SDPUtil.find_lines(this.media[i], 'a=crypto:', this.session);
                crypto.forEach(function(line) {
                    elem.c('crypto', SDPUtil.parse_crypto(line)).up();
                });
                elem.up(); // end of encryption
            }

            if (ssrc) {
                // new style mapping
                elem.c('source', { ssrc: ssrc, xmlns: 'urn:xmpp:jingle:apps:rtp:ssma:0' });
                // FIXME: group by ssrc and support multiple different ssrcs
                var ssrclines = SDPUtil.find_lines(this.media[i], 'a=ssrc:');
                ssrclines.forEach(function(line) {
                    idx = line.indexOf(' ');
                    var linessrc = line.substr(0, idx).substr(7);
                    if (linessrc != ssrc) {
                        elem.up();
                        ssrc = linessrc;
                        elem.c('source', { ssrc: ssrc, xmlns: 'urn:xmpp:jingle:apps:rtp:ssma:0' });
                    }
                    var kv = line.substr(idx + 1);
                    elem.c('parameter');
                    if (kv.indexOf(':') == -1) {
                        elem.attrs({ name: kv });
                    } else {
                        elem.attrs({ name: kv.split(':', 2)[0] });
                        elem.attrs({ value: kv.split(':', 2)[1] });
                    }
                    elem.up();
                });
                elem.up();

                // old proprietary mapping, to be removed at some point
                tmp = SDPUtil.parse_ssrc(this.media[i]);
                tmp.xmlns = 'http://estos.de/ns/ssrc';
                tmp.ssrc = ssrc;
                elem.c('ssrc', tmp).up(); // ssrc is part of description
            }

            if (SDPUtil.find_line(this.media[i], 'a=rtcp-mux')) {
                elem.c('rtcp-mux').up();
            }

            // XEP-0293 -- map a=rtcp-fb:*
            this.RtcpFbToJingle(i, elem, '*');

            // XEP-0294
            if (SDPUtil.find_line(this.media[i], 'a=extmap:')) {
                lines = SDPUtil.find_lines(this.media[i], 'a=extmap:');
                for (j = 0; j < lines.length; j++) {
                    tmp = SDPUtil.parse_extmap(lines[j]);
                    elem.c('rtp-hdrext', { xmlns: 'urn:xmpp:jingle:apps:rtp:rtp-hdrext:0',
                                    uri: tmp.uri,
                                    id: tmp.value });
                    if (tmp.hasOwnProperty('direction')) {
                        switch (tmp.direction) {
                        case 'sendonly':
                            elem.attrs({senders: 'responder'});
                            break;
                        case 'recvonly':
                            elem.attrs({senders: 'initiator'});
                            break;
                        case 'sendrecv':
                            elem.attrs({senders: 'both'});
                            break;
                        case 'inactive':
                            elem.attrs({senders: 'none'});
                            break;
                        }
                    }
                    // TODO: handle params
                    elem.up();
                }
            }
            elem.up(); // end of description
        }

        // map ice-ufrag/pwd, dtls fingerprint, candidates
        this.TransportToJingle(i, elem);

        if (SDPUtil.find_line(this.media[i], 'a=sendrecv', this.session)) {
            elem.attrs({senders: 'both'});
        } else if (SDPUtil.find_line(this.media[i], 'a=sendonly', this.session)) {
            elem.attrs({senders: 'initiator'});
        } else if (SDPUtil.find_line(this.media[i], 'a=recvonly', this.session)) {
            elem.attrs({senders: 'responder'});
        } else if (SDPUtil.find_line(this.media[i], 'a=inactive', this.session)) {
            elem.attrs({senders: 'none'});
        }
        if (mline.port == '0') {
            // estos hack to reject an m-line
            elem.attrs({senders: 'rejected'});
        }
        elem.up(); // end of content
    }
    elem.up();
    return elem;
};

SDP.prototype.TransportToJingle = function (mediaindex, elem) {
    var i = mediaindex;
    var tmp;
    var self = this;
    elem.c('transport');

    // XEP-0320
    var fingerprints = SDPUtil.find_lines(this.media[mediaindex], 'a=fingerprint:', this.session);
    fingerprints.forEach(function(line) {
        tmp = SDPUtil.parse_fingerprint(line);
        tmp.xmlns = 'urn:xmpp:tmp:jingle:apps:dtls:0';
        // tmp.xmlns = 'urn:xmpp:jingle:apps:dtls:0'; -- FIXME: update receivers first
        elem.c('fingerprint').t(tmp.fingerprint);
        delete tmp.fingerprint;
        line = SDPUtil.find_line(self.media[mediaindex], 'a=setup:', self.session);
        if (line) {
            tmp.setup = line.substr(8);
        }
        elem.attrs(tmp);
        elem.up(); // end of fingerprint
    });
    tmp = SDPUtil.iceparams(this.media[mediaindex], this.session);
    if (tmp) {
        tmp.xmlns = 'urn:xmpp:jingle:transports:ice-udp:1';
        elem.attrs(tmp);
        // XEP-0176
        if (SDPUtil.find_line(this.media[mediaindex], 'a=candidate:', this.session)) { // add any a=candidate lines
            var lines = SDPUtil.find_lines(this.media[mediaindex], 'a=candidate:', this.session);
            lines.forEach(function (line) {
                elem.c('candidate', SDPUtil.candidateToJingle(line)).up();
            });
        }
    }
    elem.up(); // end of transport
}

SDP.prototype.RtcpFbToJingle = function (mediaindex, elem, payloadtype) { // XEP-0293
    var lines = SDPUtil.find_lines(this.media[mediaindex], 'a=rtcp-fb:' + payloadtype);
    lines.forEach(function (line) {
        var tmp = SDPUtil.parse_rtcpfb(line);
        if (tmp.type == 'trr-int') {
            elem.c('rtcp-fb-trr-int', {xmlns: 'urn:xmpp:jingle:apps:rtp:rtcp-fb:0', value: tmp.params[0]});
            elem.up();
        } else {
            elem.c('rtcp-fb', {xmlns: 'urn:xmpp:jingle:apps:rtp:rtcp-fb:0', type: tmp.type});
            if (tmp.params.length > 0) {
                elem.attrs({'subtype': tmp.params[0]});
            }
            elem.up();
        }
    });
};

SDP.prototype.RtcpFbFromJingle = function (elem, payloadtype) { // XEP-0293
    var media = '';
    var tmp = elem.find('>rtcp-fb-trr-int[xmlns="urn:xmpp:jingle:apps:rtp:rtcp-fb:0"]');
    if (tmp.length) {
        media += 'a=rtcp-fb:' + '*' + ' ' + 'trr-int' + ' ';
        if (tmp.attr('value')) {
            media += tmp.attr('value');
        } else {
            media += '0';
        }
        media += '\r\n';
    }
    tmp = elem.find('>rtcp-fb[xmlns="urn:xmpp:jingle:apps:rtp:rtcp-fb:0"]');
    tmp.each(function () {
        media += 'a=rtcp-fb:' + payloadtype + ' ' + $(this).attr('type');
        if ($(this).attr('subtype')) {
            media += ' ' + $(this).attr('subtype');
        }
        media += '\r\n';
    });
    return media;
};

// construct an SDP from a jingle stanza
SDP.prototype.fromJingle = function (jingle) {
    var self = this;
    this.raw = 'v=0\r\n' +
        'o=- ' + '1923518516' + ' 2 IN IP4 0.0.0.0\r\n' +// FIXME
        's=-\r\n' +
        't=0 0\r\n';
    // http://tools.ietf.org/html/draft-ietf-mmusic-sdp-bundle-negotiation-04#section-8
    if ($(jingle).find('>group[xmlns="urn:xmpp:jingle:apps:grouping:0"]').length) {
        $(jingle).find('>group[xmlns="urn:xmpp:jingle:apps:grouping:0"]').each(function (idx, group) {
            var contents = $(group).find('>content').map(function (idx, content) {
                return content.getAttribute('name');
            }).get();
            if (contents.length > 0) {
                self.raw += 'a=group:' + (group.getAttribute('semantics') || group.getAttribute('type')) + ' ' + contents.join(' ') + '\r\n';
            }
        });
    } else if ($(jingle).find('>group[xmlns="urn:ietf:rfc:5888"]').length) {
        // temporary namespace, not to be used. to be removed soon.
        $(jingle).find('>group[xmlns="urn:ietf:rfc:5888"]').each(function (idx, group) {
            var contents = $(group).find('>content').map(function (idx, content) {
                return content.getAttribute('name');
            }).get();
            if (group.getAttribute('type') !== null && contents.length > 0) {
                self.raw += 'a=group:' + group.getAttribute('type') + ' ' + contents.join(' ') + '\r\n';
            }
        });
    } else {
        // for backward compability, to be removed soon
        // assume all contents are in the same bundle group, can be improved upon later
        var bundle = $(jingle).find('>content').filter(function (idx, content) {
            //elem.c('bundle', {xmlns:'http://estos.de/ns/bundle'});
            return $(content).find('>bundle').length > 0;
        }).map(function (idx, content) {
            return content.getAttribute('name');
        }).get();
        if (bundle.length) {
            this.raw += 'a=group:BUNDLE ' + bundle.join(' ') + '\r\n';
        }
    }

    this.session = this.raw;
    jingle.find('>content').each(function () {
        var m = self.jingle2media($(this));
        self.media.push(m);
    });

    // reconstruct msid-semantic -- apparently not necessary
    /*
    var msid = SDPUtil.parse_ssrc(this.raw);
    if (msid.hasOwnProperty('mslabel')) {
        this.session += "a=msid-semantic: WMS " + msid.mslabel + "\r\n";
    }
    */

    this.raw = this.session + this.media.join('');
};

// translate a jingle content element into an an SDP media part
SDP.prototype.jingle2media = function (content) {
    var media = '',
        desc = content.find('description'),
        ssrc = desc.attr('ssrc'),
        self = this,
        tmp;

    tmp = { media: desc.attr('media') };
    tmp.port = '1';
    if (content.attr('senders') == 'rejected') {
        // estos hack to reject an m-line.
        tmp.port = '0';
    }
    if (content.find('>transport>fingerprint').length || desc.find('encryption').length) {
        tmp.proto = 'RTP/SAVPF';
    } else {
        tmp.proto = 'RTP/AVPF';
    }
    tmp.fmt = desc.find('payload-type').map(function () { return this.getAttribute('id'); }).get();
    media += SDPUtil.build_mline(tmp) + '\r\n';
    media += 'c=IN IP4 0.0.0.0\r\n';
    media += 'a=rtcp:1 IN IP4 0.0.0.0\r\n';
    tmp = content.find('>transport[xmlns="urn:xmpp:jingle:transports:ice-udp:1"]');
    if (tmp.length) {
        if (tmp.attr('ufrag')) {
            media += SDPUtil.build_iceufrag(tmp.attr('ufrag')) + '\r\n';
        }
        if (tmp.attr('pwd')) {
            media += SDPUtil.build_icepwd(tmp.attr('pwd')) + '\r\n';
        }
        tmp.find('>fingerprint').each(function () {
            // FIXME: check namespace at some point
            media += 'a=fingerprint:' + this.getAttribute('hash');
            media += ' ' + $(this).text();
            media += '\r\n';
            if (this.getAttribute('setup')) {
                media += 'a=setup:' + this.getAttribute('setup') + '\r\n';
            }
        });
    }
    switch (content.attr('senders')) {
    case 'initiator':
        media += 'a=sendonly\r\n';
        break;
    case 'responder':
        media += 'a=recvonly\r\n';
        break;
    case 'none':
        media += 'a=inactive\r\n';
        break;
    case 'both':
        media += 'a=sendrecv\r\n';
        break;
    }
    media += 'a=mid:' + content.attr('name') + '\r\n';

    // <description><rtcp-mux/></description>
    // see http://code.google.com/p/libjingle/issues/detail?id=309 -- no spec though
    // and http://mail.jabber.org/pipermail/jingle/2011-December/001761.html
    if (desc.find('rtcp-mux').length) {
        media += 'a=rtcp-mux\r\n';
    }

    if (desc.find('encryption').length) {
        desc.find('encryption>crypto').each(function () {
            media += 'a=crypto:' + this.getAttribute('tag');
            media += ' ' + this.getAttribute('crypto-suite');
            media += ' ' + this.getAttribute('key-params');
            if (this.getAttribute('session-params')) {
                media += ' ' + this.getAttribute('session-params');
            }
            media += '\r\n';
        });
    }
    desc.find('payload-type').each(function () {
        media += SDPUtil.build_rtpmap(this) + '\r\n';
        if ($(this).find('>parameter').length) {
            media += 'a=fmtp:' + this.getAttribute('id') + ' ';
            media += $(this).find('parameter').map(function () { return (this.getAttribute('name') ? (this.getAttribute('name') + '=') : '') + this.getAttribute('value'); }).get().join(';');
            media += '\r\n';
        }
        // xep-0293
        media += self.RtcpFbFromJingle($(this), this.getAttribute('id'));
    });

    // xep-0293
    media += self.RtcpFbFromJingle(desc, '*');

    // xep-0294
    tmp = desc.find('>rtp-hdrext[xmlns="urn:xmpp:jingle:apps:rtp:rtp-hdrext:0"]');
    tmp.each(function () {
        media += 'a=extmap:' + this.getAttribute('id') + ' ' + this.getAttribute('uri') + '\r\n';
    });

    content.find('>transport[xmlns="urn:xmpp:jingle:transports:ice-udp:1"]>candidate').each(function () {
        media += SDPUtil.candidateFromJingle(this);
    });

    tmp = content.find('description>source[xmlns="urn:xmpp:jingle:apps:rtp:ssma:0"]');
    tmp.each(function () {
        var ssrc = this.getAttribute('ssrc');
        $(this).find('>parameter').each(function () {
            media += 'a=ssrc:' + ssrc + ' ' + this.getAttribute('name');
            if (this.getAttribute('value') && this.getAttribute('value').length)
                media += ':' + this.getAttribute('value');
            media += '\r\n';
        });
    });

    if (tmp.length === 0) {
        // fallback to proprietary mapping of a=ssrc lines
        tmp = content.find('description>ssrc[xmlns="http://estos.de/ns/ssrc"]');
        if (tmp.length) {
            media += 'a=ssrc:' + ssrc + ' cname:' + tmp.attr('cname') + '\r\n';
            media += 'a=ssrc:' + ssrc + ' msid:' + tmp.attr('msid') + '\r\n';
            media += 'a=ssrc:' + ssrc + ' mslabel:' + tmp.attr('mslabel') + '\r\n';
            media += 'a=ssrc:' + ssrc + ' label:' + tmp.attr('label') + '\r\n';
        }
    }
    return media;
};

SDPUtil = {
    iceparams: function (mediadesc, sessiondesc) {
        var data = null;
        if (SDPUtil.find_line(mediadesc, 'a=ice-ufrag:', sessiondesc) &&
            SDPUtil.find_line(mediadesc, 'a=ice-pwd:', sessiondesc)) {
            data = {
                ufrag: SDPUtil.parse_iceufrag(SDPUtil.find_line(mediadesc, 'a=ice-ufrag:', sessiondesc)),
                pwd: SDPUtil.parse_icepwd(SDPUtil.find_line(mediadesc, 'a=ice-pwd:', sessiondesc))
            };
        }
        return data;
    },
    parse_iceufrag: function (line) {
        return line.substring(12);
    },
    build_iceufrag: function (frag) {
        return 'a=ice-ufrag:' + frag;
    },
    parse_icepwd: function (line) {
        return line.substring(10);
    },
    build_icepwd: function (pwd) {
        return 'a=ice-pwd:' + pwd;
    },
    parse_mid: function (line) {
        return line.substring(6);
    },
    parse_mline: function (line) {
        var parts = line.substring(2).split(' '),
        data = {};
        data.media = parts.shift();
        data.port = parts.shift();
        data.proto = parts.shift();
        if (parts[parts.length - 1] === '') { // trailing whitespace
            parts.pop();
        }
        data.fmt = parts;
        return data;
    },
    build_mline: function (mline) {
        return 'm=' + mline.media + ' ' + mline.port + ' ' + mline.proto + ' ' + mline.fmt.join(' ');
    },
    parse_rtpmap: function (line) {
        var parts = line.substring(9).split(' '),
            data = {};
        data.id = parts.shift();
        parts = parts[0].split('/');
        data.name = parts.shift();
        data.clockrate = parts.shift();
        data.channels = parts.length ? parts.shift() : '1';
        return data;
    },
    build_rtpmap: function (el) {
        var line = 'a=rtpmap:' + el.getAttribute('id') + ' ' + el.getAttribute('name') + '/' + el.getAttribute('clockrate');
        if (el.getAttribute('channels') && el.getAttribute('channels') != '1') {
            line += '/' + el.getAttribute('channels');
        }
        return line;
    },
    parse_crypto: function (line) {
        var parts = line.substring(9).split(' '),
        data = {};
        data.tag = parts.shift();
        data['crypto-suite'] = parts.shift();
        data['key-params'] = parts.shift();
        if (parts.length) {
            data['session-params'] = parts.join(' ');
        }
        return data;
    },
    parse_fingerprint: function (line) { // RFC 4572
        var parts = line.substring(14).split(' '),
        data = {};
        data.hash = parts.shift();
        data.fingerprint = parts.shift();
        // TODO assert that fingerprint satisfies 2UHEX *(":" 2UHEX) ?
        return data;
    },
    parse_fmtp: function (line) {
        var parts = line.split(' '),
            i, key, value,
            data = [];
        parts.shift();
        parts = parts.join(' ').split(';');
        for (i = 0; i < parts.length; i++) {
            key = parts[i].split('=')[0];
            while (key.length && key[0] == ' ') {
                key = key.substring(1);
            }
            value = parts[i].split('=')[1];
            if (key && value) {
                data.push({name: key, value: value});
            } else if (key) {
                // rfc 4733 (DTMF) style stuff
                data.push({name: '', value: key});
            }
        }
        return data;
    },
    parse_icecandidate: function (line) {
        var candidate = {},
            elems = line.split(' ');
        candidate.foundation = elems[0].substring(12);
        candidate.component = elems[1];
        candidate.protocol = elems[2].toLowerCase();
        candidate.priority = elems[3];
        candidate.ip = elems[4];
        candidate.port = elems[5];
        // elems[6] => "typ"
        candidate.type = elems[7];
        candidate.generation = 0; // default value, may be overwritten below
        for (var i = 8; i < elems.length; i += 2) {
            switch (elems[i]) {
            case 'raddr':
                candidate['rel-addr'] = elems[i + 1];
                break;
            case 'rport':
                candidate['rel-port'] = elems[i + 1];
                break;
            case 'generation':
                candidate.generation = elems[i + 1];
                break;
            case 'tcptype':
                candidate.tcptype = elems[i + 1];
                break;
            default: // TODO
                console.log('parse_icecandidate not translating "' + elems[i] + '" = "' + elems[i + 1] + '"');
            }
        }
        candidate.network = '1';
        candidate.id = Math.random().toString(36).substr(2, 10); // not applicable to SDP -- FIXME: should be unique, not just random
        return candidate;
    },
    build_icecandidate: function (cand) {
        var line = ['a=candidate:' + cand.foundation, cand.component, cand.protocol, cand.priority, cand.ip, cand.port, 'typ', cand.type].join(' ');
        line += ' ';
        switch (cand.type) {
        case 'srflx':
        case 'prflx':
        case 'relay':
            if (cand.hasOwnAttribute('rel-addr') && cand.hasOwnAttribute('rel-port')) {
                line += 'raddr';
                line += ' ';
                line += cand['rel-addr'];
                line += ' ';
                line += 'rport';
                line += ' ';
                line += cand['rel-port'];
                line += ' ';
            }
            break;
        }
        if (cand.hasOwnAttribute('tcptype')) {
            line += 'tcptype';
            line += ' ';
            line += cand.tcptype;
            line += ' ';
        }
        line += 'generation';
        line += ' ';
        line += cand.hasOwnAttribute('generation') ? cand.generation : '0';
        return line;
    },
    parse_ssrc: function (desc) {
        // proprietary mapping of a=ssrc lines
        // TODO: see "Jingle RTP Source Description" by Juberti and P. Thatcher on google docs
        // and parse according to that
        var lines = desc.split('\r\n'),
            data = {};
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].substring(0, 7) == 'a=ssrc:') {
                var idx = lines[i].indexOf(' ');
                data[lines[i].substr(idx + 1).split(':', 2)[0]] = lines[i].substr(idx + 1).split(':', 2)[1];
            }
        }
        return data;
    },
    parse_rtcpfb: function (line) {
        var parts = line.substr(10).split(' ');
        var data = {};
        data.pt = parts.shift();
        data.type = parts.shift();
        data.params = parts;
        return data;
    },
    parse_extmap: function (line) {
        var parts = line.substr(9).split(' ');
        var data = {};
        data.value = parts.shift();
        if (data.value.indexOf('/') != -1) {
            data.direction = data.value.substr(data.value.indexOf('/') + 1);
            data.value = data.value.substr(0, data.value.indexOf('/'));
        } else {
            data.direction = 'both';
        }
        data.uri = parts.shift();
        data.params = parts;
        return data;
    },
    find_line: function (haystack, needle, sessionpart) {
        var lines = haystack.split('\r\n');
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].substring(0, needle.length) == needle) {
                return lines[i];
            }
        }
        if (!sessionpart) {
            return false;
        }
        // search session part
        lines = sessionpart.split('\r\n');
        for (var j = 0; j < lines.length; j++) {
            if (lines[j].substring(0, needle.length) == needle) {
                return lines[j];
            }
        }
        return false;
    },
    find_lines: function (haystack, needle, sessionpart) {
        var lines = haystack.split('\r\n'),
            needles = [];
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].substring(0, needle.length) == needle)
                needles.push(lines[i]);
        }
        if (needles.length || !sessionpart) {
            return needles;
        }
        // search session part
        lines = sessionpart.split('\r\n');
        for (var j = 0; j < lines.length; j++) {
            if (lines[j].substring(0, needle.length) == needle) {
                needles.push(lines[j]);
            }
        }
        return needles;
    },
    candidateToJingle: function (line) {
        // a=candidate:2979166662 1 udp 2113937151 192.168.2.100 57698 typ host generation 0
        //      <candidate component=... foundation=... generation=... id=... ip=... network=... port=... priority=... protocol=... type=.../>
        if (line.indexOf('candidate:') === 0) {
            line = 'a=' + line;
        } else if (line.substring(0, 12) != 'a=candidate:') {            
			console.log('parseCandidate called with a line that is not a candidate line');
            console.log(line);
            return null;
        }
        if (line.substring(line.length - 2) == '\r\n') // chomp it
            line = line.substring(0, line.length - 2);
        var candidate = {},
            elems = line.split(' '),
            i;
        if (elems[6] != 'typ') {
            console.log('did not find typ in the right place');
            console.log(line);
            return null;
        }
        candidate.foundation = elems[0].substring(12);
        candidate.component = elems[1];
        candidate.protocol = elems[2].toLowerCase();
        candidate.priority = elems[3];
        candidate.ip = elems[4];
        candidate.port = elems[5];
        // elems[6] => "typ"
        candidate.type = elems[7];

        candidate.generation = '0'; // fippo from jitsi-meet: default, may be overwritten below

        for (i = 8; i < elems.length; i += 2) {
            switch (elems[i]) {
            case 'raddr':
                candidate['rel-addr'] = elems[i + 1];
                break;
            case 'rport':
                candidate['rel-port'] = elems[i + 1];
                break;
            case 'generation':
                candidate.generation = elems[i + 1];
                break;
            case 'tcptype':
                candidate.tcptype = elems[i + 1];
                break;
            default: // TODO
                console.log('not translating "' + elems[i] + '" = "' + elems[i + 1] + '"');
            }
        }
        candidate.network = '1';
        candidate.id = Math.random().toString(36).substr(2, 10); // not applicable to SDP -- FIXME: should be unique, not just random
        return candidate;
    },
    candidateFromJingle: function (cand) {
        var line = 'a=candidate:';
        line += cand.getAttribute('foundation');
        line += ' ';
        line += cand.getAttribute('component');
        line += ' ';
        line += cand.getAttribute('protocol'); //.toUpperCase(); // chrome M23 doesn't like this
        line += ' ';
        line += cand.getAttribute('priority');
        line += ' ';
        line += cand.getAttribute('ip');
        line += ' ';
        line += cand.getAttribute('port');
        line += ' ';
        line += 'typ';
        line += ' ' + cand.getAttribute('type');
        line += ' ';
        switch (cand.getAttribute('type')) {
        case 'srflx':
        case 'prflx':
        case 'relay':
            if (cand.getAttribute('rel-addr') && cand.getAttribute('rel-port')) {
                line += 'raddr';
                line += ' ';
                line += cand.getAttribute('rel-addr');
                line += ' ';
                line += 'rport';
                line += ' ';
                line += cand.getAttribute('rel-port');
                line += ' ';
            }
            break;
        }
        line += 'generation';
        line += ' ';
        line += cand.getAttribute('generation') || '0';
        return line + '\r\n';
    }
};
}(jQuery));
