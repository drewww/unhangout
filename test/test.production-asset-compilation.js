describe("PRODUCTION ASSET COMPILATION", function() {
    this.timeout(40000); // Extra-long timeout for compilation. :(
    if (process.env.SKIP_SELENIUM_TESTS) {
        // Even though we don't use selenium here, act as though we do because
        // we're so slow.
        return;
    }
    it("Compiles assets in production", function(done) {
        var requireAssets = require("../lib/require-assets.js");
        var conf = require("../public/js/requirejs-config.json");
        var count = Object.keys(conf.modules).length - 1;
        var errors = [];
        requireAssets.middleware(true, function(err) {
            if (err) {
                errors.push(err);
            }
            count--;
            if (count === 0) {
                return done(errors.length > 0 ? new Error(errors) : null);
            }
        });
    });
});

