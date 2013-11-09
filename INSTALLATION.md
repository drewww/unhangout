Setting up the development environment
======================================

Unhangout is an un-conference style platform for organizing Google hangout sessions. Following are the steps for 
setting up the development environment on Ubuntu/Debian machine.

A. Installing node.js (any version)
-----------------------------------

Update your system

    $ sudo apt-get update
        
Setup the system to handle compiling and installing from source 

    $ sudo apt-get build-essential

To enable SSL support install libssl-dev 

    $ sudo apt-get install libssl-dev

Install curl used by install script

    $ sudo apt-get install curl

Cloning into node.js repository 

    $ git clone https://github.com/joyent/node.git  
    $ cd node 

Checkout a specific version of node.js 

    $ git tag # Gives you a list of released versions  
    $ git checkout v0.9.9 

Compile and install node 

    $ ./configure 
    $ make 
    $ sudo make install 

To check if the node is installed properly 

    $ node -v 
    $ v0.9.9
     
    
B. Cloning the Repository.
--------------------------

  - Clone unhangout repository from github <br>
    $ git clone http://github.com/drewww/unhangout <br>
    $ cd unhangout

C. Install prerequisites.
-------------------------

Install redis:

    $ sudo apt-get install redis-server 
    
Install the required dependencies in local node_modules folder

    $ npm install

If you run selenium tests, install java and download ``selenium-server-standalone.jar`` from https://code.google.com/p/selenium/downloads/list, and specify its location in conf.json under ``TESTING_SELENIUM_PATH``.


D. Configuration
----------------
    
Create a file and copy the contents of conf.json.example file in it. Name this file conf.json.  conf.json.example file contains environment variables to specify server settings.

    $ touch conf.json <br>
    $ gedit conf.json [copy contents from conf.json.example here]

  - ``GOOGLE_CLIENT_ID`` and ``GOOGLE_CLIENT_SECRET`` fields are app
    credentials that can be configured and obtained at
    http://code.google.com/apis/console/.  In the Google API console, you
    should make a "Client ID for web applications" - that will create the
    necessary CLIENT_ID and CLIENT_SECRET you need to authenticate with Google
    and create calendar events.  Set the callback URL to
    https://localhost:7777/auth/google/callback (swap out the hostname and port
    with whichever settings you use).

  - ``UNHANGOUT_ADMIN_EMAILS`` is a list of email addresses which are granted
    "admin" status when they authenticate.  (The server must be restarted and
    clients must re-login to change their admin status).

  - ``UNHANGOUT_REDIS_HOST`` and ``UNHANGOUT_REDIS_PORT`` are the host and port
    name for the installed redis.  Defaults are ``localhost`` and ``6379``.
  - ``UNHANOGUT_REDIS_DB`` is an index number pointing to the redis database to
    use. By default, we use 0 for production.  The unit tests use 1, and will
    destroy data there.
  - ``UNHANGOUT_ADMIN_EMAILS`` is a list of email addresses which are granted
    admin status.
  - ``UNHANGOUT_HANGOUT_APP_ID`` is the Google app ID for our hangout gadget.
  - ``UNHANGOUT_USE_SSL``: if true, the server will run with SSL.  We strongly
    recommend running the unhangout server with SSL, even in development (you
    can use ``https://localhost:7777/``).  Google Hangouts are always run over
    SSL, and trying to run a hangout application over http causes many browsers
    to refuse to send requests, which causes a number of insidious issues. 
  - ``UNHANGOUT_PRIVATE_KEY`` and ``UNHANGOUT_CERTIFICATE`` are the private key
    and certificate to use for SSL.  For development purposes, a self-signed
    certificate will work fine. These instructions from Heroku are quite good:
    https://devcenter.heroku.com/articles/ssl-certificate-self If you follow
    those instructions, you will have two resulting files:
      - server.key is your private key, move it to `ssl/` and set the path to that file in UNHANGOUT_PRIVATE_KEY
      - server.crt is your certificate, move it to `ssl/` and set the path to that file in UNHANGOUT_CERTIFICATE

    For production purposes, you will need to obtain a certificate signed by a
    known certificate authority. Some providers (such as StartSSL) offer free
    SSL certificates that are recognized by major browsers.  The Heroku
    instructions for SSL certificates will show you how to generate a
    certificate signing request, which you will provide to an SSL issuer:
    https://devcenter.heroku.com/articles/ssl-endpoint#acquire-ssl-certificate

  - ``HANGOUT_REDIRECT_HTTP``: This will start a separate HTTP server that will
    redirect any requests to their HTTPS equivalent. This presumes that you're
    using default ports: 80 for HTTP, and 443 for HTTPS, so it requres sudo to
    bind to privileged ports. In most production situations, you will want to
    enable UNHANGOUT_REDIRECT_HTTP. In development contexts, set
    UNHANGOUT_REDIRECT_HTTP to false, and use HTTPS on whatever port you
    desire.

  - ``EMAIL_LOG_RECIPIENTS``: When running with the ``NODE_ENV=production``
    environment variable set, emails reporting any errors logged by the server
    will be sent to the addresses listed here.

  - ``TESTING_SELENIUM_PATH``: The path to "selenium-server-standalone.jar",
    required to run tests with selenium.

E. Making changes to the codebase
---------------------------------

You can start the node server with:

    $ npm start

and browse the site in ``https://localhost:7777`` (or whichever hosts/ports
you've configured).  The development workflow for making changes is as follows:

Create a new branch in git unhangout repository

    $ git branch branch-name

Push the newly created branch on github

    $ git push origin branch-name

Switch to the new branch

    $ git checkout branch-name

Be sure to be in the newly created branch

    $ git branch
    $ *branch-name
    $  master 

Make desired changes in the code base and push them to github <br>

    $ git add file-name
    $ git commit -m "commit-message"
    $ git push origin branch-name

Go to github and send a pull request. 

F. Testing
----------

Tests use mocha and selenium-webdriver (for live browser tests with Firefox).  To run selenium tests, you must download ``selenium-server-standalone.jar`` from https://code.google.com/p/selenium/downloads/list, and set ``TESTING_SELENIUM_PATH`` in ``conf.json`` to its path. 

You can run tests using the npm helper script <br>

    $ npm test <br>

By installing mocha globally, you can invoke it directly, as well as cherry-picking individual tests:

    $ sudo npm install -g mocha
    $ mocha -R nyan

To suppress display of the web browser when running selenium tests, install and run with ``xvfb``, a "headless" X-server:

    $ sudo apt-get install xvfb
    $ DISPLAY=99.0 xvfb-run npm test

Alternately, you can skip selenium tests (which are very slow) outright by setting the SKIP_SELENIUM_TESTS environment variable:

    $ SKIP_SELENIUM_TESTS=1 npm test

