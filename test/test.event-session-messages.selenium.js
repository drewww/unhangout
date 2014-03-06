var expect = require('expect.js'),
    _ = require("underscore"),
    common = require('./common');

describe("EVENT SESSION MESSAGES", function() {
    var browser = null,
        event = null;

    if (process.env.SKIP_SELENIUM_TESTS) {
        return;
    }
    this.timeout(60000); // Extra long timeout for selenium :(

    before(function(done) {
        common.getSeleniumBrowser(function (theBrowser) {
            browser = theBrowser;
            common.standardSetup(function() {
                event = common.server.db.events.findWhere({shortName: "writers-at-work"});
                event.start();
                done();
            });
        });
    });
    after(function(done) {
        browser.quit().then(function() {
            common.standardShutdown(done);
        });
    });

    it("Admin sends a message to sessions.", function(done) {
        // Test that an admin sending a message via the "Send message to
        // sessions" successfully generates a socket message in one of the
        // event's session rooms.
        var sock;
        var session = event.get("sessions").at(0);
        browser.get("http://localhost:7777/");
        browser.mockAuthenticate("superuser1");
        // Admin goes to the event page.  Connect a socket to a session.
        browser.get("http://localhost:7777/event/" + event.id)
        browser.wait(function() {
            return browser.executeScript("return window.$ !== null");
        }).then(function() {
            common.authedSock("regular2", session.getRoomId(), function(theSock) {
                sock = theSock;
                function onData(data) {
                    var message = JSON.parse(data);
                    expect(message.type).to.be("session/event-message"); 
                    expect(message.args).to.eql({
                        sender: "Superuser1 Mock",
                        message: "##unhangouts## Superuser1 Mock: This is fun!",
                    });
                    sock.removeListener("data", onData);
                    sock.promiseClose().then(function() {
                        done();
                    });
                }
                sock.on("data", onData);
            });
        });
        // Wait for the user to show up as a participant.
        browser.waitForSelector("#session-list .session[data-session-id='"
                                + session.id + "'] li i.icon-user");
        // Send the message... sock's on("data, ...) handler will pick it up
        // and finish the test once we do.
        browser.byCss(".admin-button").click();
        browser.waitForSelector("#message-sessions");
        browser.byCss("#message-sessions").click();
        browser.waitForSelector("textarea#session_message");
        browser.byCss("textarea#session_message").sendKeys("This is fun!");
        browser.byCss("#send-session-message").click();
    });

    it("Sessions display message sent by admin", function(done) {
        
        var sock;
        var session = event.get("sessions").at(0);

        browser.get("http://localhost:7777/");
        browser.mockAuthenticate("regular1");
        browser.get("http://localhost:7777/test/hangout/" + session.id + "/");
        browser.waitForSelector("iframe[name='gadget_frame']");
        browser.switchTo().frame("gadget_frame");
        browser.waitForSelector("iframe[name='facilitator_frame']");

        // Generate an event message.
        browser.then(function() {
            common.authedSock("superuser1", event.getRoomId(), function(theSock) {
                sock = theSock;
                sock.write(JSON.stringify({
                    type: "broadcast-message-to-sessions",
                    args: {
                        roomId: event.getRoomId(),
                        message: "##unhangouts## Superuser1 Mock: Hey there session",
                    }
                }));
            });
        });

        browser.waitForSelector("#mock-hangout-notice p");
        browser.byCss("#mock-hangout-notice p").getText().then(function(text) {
            expect(text).to.eql("##unhangouts## Superuser1 Mock: Hey there session");
            sock.promiseClose().then(function() {
                done();
            });
        });
    });

    it("Adds event url to message", function(done) {
        browser.get("http://localhost:7777/");
        browser.mockAuthenticate("superuser1");
        browser.get("http://localhost:7777/event/" + event.id);
        browser.byCss(".admin-button").click();
        browser.waitForSelector("#message-sessions");
        browser.byCss("#message-sessions").click();
        browser.waitForSelector("textarea#session_message");
        browser.byCss("textarea#session_message").sendKeys("This is fun!");
        browser.byCss(".add-url-to-message").click();
        browser.byCss("textarea#session_message").getAttribute("value").then(function(text) {
            expect(text).to.eql("This is fun!\n Copy and paste: http://localhost:7777/event/" + event.id);
            done();

        });

    });
});
