var server = require("../lib/unhangout-server"),
    models = require("../lib/server-models"),
    farming = require("../lib/hangout-farming"),
    common = require("./common"),
    expect = require("expect.js"),
    _ = require("underscore"),
    request = require("superagent"),
    sinon = require('sinon'),
    async = require('async');

describe("HANGOUT REDIRECTS", function() {
    var event;
    var session;
    var suffix;

    beforeEach(function(done) {
        common.standardSetup(function() {
            // Grab a session to work with.
            common.server.db.events.any(function(e) {
                event = e;
                if (e.get("sessions").length > 0) {
                    e.start();
                    session = e.get("sessions").at(0);
                    suffix = function(sockKey, sess) {
                        sess = sess || session;
                        var user = common.server.db.users.findWhere({"sock-key": sockKey});
                        return "?gid=rofl&gd=sessionId:" + sess.id +
                            ":sockKey:" + sockKey + ":userId:" + user.id;
                    }
                    return true;
                }
            });
            if (!session) {
                console.log("error", common.server.db.events.toJSON());
                throw new Error("No sessions loaded!");
            }
            done();
        });
    });
    afterEach(common.standardShutdown);

    function checkRedirect(expected, user, done) {
        request.get("http://localhost:7777" + session.getParticipationLink())
            .timeout(models.ServerSession.prototype.HANGOUT_CREATION_TIMEOUT + 2)
            .set("x-mock-user", user)
            .redirects(0)
            .end(function(res) {
                expect(res.status).to.be(302);
                expect(res.headers.location).to.be(expected);
                done();
            });
    }

    it("Uses existing hangout link when present", function(done) {
        var success = session.setHangoutUrl("http://example.com/hangy");
        expect(success).to.be(true);
        checkRedirect("http://example.com/hangy" + suffix("regular1"), "regular1", done);
    });

    it("Waits for a link when pending, and uses it when available", function(done) {
        var user = common.server.db.users.findWhere({"sock-key": "regular1"});
        session.markHangoutPending(user);
        expect(session.get("hangout-pending").userId).to.eql(user.id);
        expect(session.isHangoutPending()).to.be(true);

        var clock = sinon.useFakeTimers();
        async.parallel([
            function(done) {
                checkRedirect("http://example.com/hangy" + suffix("regular1"), "regular1", done);
            },
            function(done) {
                // Make sure this timeout is greater than the express default
                // timeout, so we can ensure that we've increased it on the express
                // route handler appropriately.
                clock.tick(10000);

                session.setHangoutUrl("http://example.com/hangy");
                expect(session.isHangoutPending()).to.be(false);
                expect(session.get('hangout-url')).to.eql('http://example.com/hangy');
                done();
            },
        ], function() {
            expect(session.get("hangout-pending")).to.be(null);
            expect(session.isHangoutPending()).to.be(false);
            clock.restore();
            done();
        });
    });

    it("Uses a farmed hangout link when available", function(done) {
        farming.reuseUrl("http://example.com/farmed", function(err) {
            expect(err).to.be(null);

            var url = "http://example.com/farmed" + suffix("regular1");
            checkRedirect(url, "regular1", function() {
                farming.getNextHangoutUrl(function(err, url) {
                    expect(err).to.be(null);
                    expect(url).to.be(null);
                    done();
                });
            });
        });
    });

    it("Uses button URL when farmed hangout links are unavailable", function(done) {
        // Ensure we have nothing farmed...
        farming.getNextHangoutUrl(function(err, url) {
            expect(err).to.be(null);
            expect(url).to.be(null);
            var url = "https://plus.google.com/hangouts/_" + suffix("regular1");
            checkRedirect(url, "regular1", function() {
                expect(session.isHangoutPending()).to.be(true);
                done();
            });
        });
    });

    it("Lets a 2nd user be the pending creator if the 1st times out", function(done) {
        var u1 = common.server.db.users.findWhere({"sock-key": "regular1"});
        var u2 = common.server.db.users.findWhere({"sock-key": "regular2"});
        var url = "https://plus.google.com/hangouts/_" + suffix("regular2");

        var clock = sinon.useFakeTimers();

        // u1 is the user with the pending hangout...
        session.markHangoutPending(u1);
        // Second user tries to connect...
        checkRedirect(url, u2.get("sock-key"), function() {
            expect(session.get("hangout-pending").userId).to.be(u2.id);
            clock.restore();
            done();
        });
        // First user never returns -- time advances.
        clock.tick(models.ServerSession.prototype.HANGOUT_CREATION_TIMEOUT + 1);

    });

    it("Retains a farmed url after adding it to a session if someone joins", function(done) {
        var user = common.server.db.users.findWhere({"sock-key": "regular1"});
        var url = "http://example.com/good-url";

        var clock = sinon.useFakeTimers();

        farming.reuseUrl(url, function(err) {
            expect(err).to.be(null);
            checkRedirect(url + suffix("regular1"), "regular1", function() {
                session.setConnectedParticipants([{id: user.id}]);
                clock.tick(models.ServerSession.prototype.HANGOUT_CONNECTION_TIMEOUT - 1);
                expect(session.get("hangout-url")).to.be(url);
                clock.restore();
                done();
            });
        });
    });

    it("Times-out a farmed url (without re-using it) after adding it to a session if no one joins", function(done) {
        var url = "http://example.com/poison-url";
        var clock = sinon.useFakeTimers();
        expect(farming.getNumHangoutsAvailable()).to.be(0);

        farming.reuseUrl(url, function(err) {
            expect(err).to.be(null);
            // We should get the farmed (poison) url...
            checkRedirect(url + suffix("regular1"), "regular1", function() {
                // ... but we don't enter the session, and never start it.
                clock.tick(models.ServerSession.prototype.HANGOUT_CONNECTION_TIMEOUT + 1);
                expect(session.get("hangout-url")).to.be(null);
                farming.getNextHangoutUrl(function(err, url) {
                    expect(err).to.be(null);
                    expect(url).to.be(null);
                    clock.restore();
                    done();
                });
            });
        });
    });

    it("Renders error page when the hangout is full", function(done) {
        session.set("connectedParticipants", [
            {id: "u0", displayName: "U0", picture: ""},
            {id: "u1", displayName: "U1", picture: ""},
            {id: "u2", displayName: "U2", picture: ""},
            {id: "u3", displayName: "U3", picture: ""},
            {id: "u4", displayName: "U4", picture: ""},
        ]);
        session.set("joiningParticipants", [
            {id: "u5", displayName: "U5", picture: ""},
            {id: "u6", displayName: "U6", picture: ""},
            {id: "u7", displayName: "U7", picture: ""},
            {id: "u8", displayName: "U8", picture: ""},
            {id: "u9", displayName: "U9", picture: ""},
        ]);
        request.get("http://localhost:7777" + session.getParticipationLink())
            .set("x-mock-user", "regular1")
            .redirects(0)
            .end(function(res) {
                expect(res.status).to.be(200);
                expect(res.text).to.contain("Session full");
                done();
            });
    });
    describe("HoA REDIRECT", function() {
        var hoa;
        beforeEach(function() {
            hoa = new models.ServerHoASession({id: "t1"});
            event.setHoA(hoa);
            hoa.event = event;
        });


        it("Session router redirects to hoa-session for HoAs", function(done) {
            request.get("http://localhost:7777/session/" + hoa.get("session-key"))
                .set("x-mock-user", "regular1")
                .redirects(0)
                .end(function(res) {
                    expect(res.status).to.be(302);
                    expect(res.headers.location).to.be(
                        "/hoa-session/" + hoa.get("session-key")
                    )
                    done();
                });
        });
        it("redirects to regular session if it isn't an hoa", function(done) {
            request.get("http://localhost:7777/hoa-session/" + session.get("session-key"))
                .set("x-mock-user", "regular1")
                .redirects(0)
                .end(function(res) {
                    expect(res.status).to.be(302);
                    expect(res.headers.location).to.be(
                        "/session/" + session.get("session-key")
                    )
                    done();
                });
        });
        it("gives forbiden for non-admins", function(done) {
            request.get("http://localhost:7777" + hoa.getParticipationLink())
                .set("x-mock-user", "regular1")
                .redirects(0)
                .end(function(res) {
                    expect(res.status).to.be(403);
                    done();
                });
        });
        it("uses existing URL if present", function(done) {
            hoa.set("hangout-url", "http://example.com/hoastic");
            request.get("http://localhost:7777" + hoa.getParticipationLink())
                .set("x-mock-user", "superuser1")
                .redirects(0)
                .end(function(res) {
                    expect(res.status).to.be(302);
                    expect(res.headers.location).to.be(
                        "http://example.com/hoastic" + suffix("superuser1", hoa)
                    );
                    done();
                });
        });
        it("renders hangout-pending if it is", function(done) {
            var u = common.server.db.users.findWhere({"sock-key": "admin1"});
            var clock = sinon.useFakeTimers();
            hoa.markHangoutPending(u);

            clock.tick(hoa.HANGOUT_CREATION_TIMEOUT / 2);

            request.get("http://localhost:7777" + hoa.getParticipationLink())
                .set("x-mock-user", "superuser1")
                .redirects(0)
                .end(function(res) {
                    expect(res.status).to.be(200);
                    expect(res.text).to.contain(
                        "Hangout-on-air creation already started"
                    );
                    clock.tick(hoa.HANGOUT_CREATION_TIMEOUT / 2 + 1);
                    // After timeout shows create-hoa.
                    request.get("http://localhost:7777" + hoa.getParticipationLink())
                        .set("x-mock-user", "superuser1")
                        .redirects(0)
                        .end(function(res) {
                            expect(res.status).to.be(200);
                            expect(res.text).to.contain("Create Hangout-on-air?");
                            clock.restore()
                            done();
                        });
                });

        });
        it("renders create-hoa if there's no URL", function(done) {
            request.get("http://localhost:7777" + hoa.getParticipationLink())
                .set("x-mock-user", "superuser1")
                .redirects(0)
                .end(function(res) {
                    expect(res.status).to.be(200);
                    expect(res.text).to.contain("Create Hangout-on-air?");
                    done();
                });
        });
    });
});
