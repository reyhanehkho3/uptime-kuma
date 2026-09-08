const dayjs = require("dayjs");
const axios = require("axios");
const { setTimeout, clearTimeout } = require("unlimited-timeout");
const { Prometheus } = require("../prometheus");
const {
    log,
    UP,
    DOWN,
    PENDING,
    MAINTENANCE,
    flipStatus,
    MIN_INTERVAL_SECOND,
    SQL_DATETIME_FORMAT,
    evaluateJsonQuery,
    PING_PACKET_SIZE_MIN,
    PING_PACKET_SIZE_MAX,
    PING_PACKET_SIZE_DEFAULT,
    PING_GLOBAL_TIMEOUT_MIN,
    PING_GLOBAL_TIMEOUT_MAX,
    PING_GLOBAL_TIMEOUT_DEFAULT,
    PING_COUNT_MIN,
    PING_COUNT_MAX,
    PING_COUNT_DEFAULT,
    PING_PER_REQUEST_TIMEOUT_MIN,
    PING_PER_REQUEST_TIMEOUT_MAX,
    PING_PER_REQUEST_TIMEOUT_DEFAULT,
    RESPONSE_BODY_LENGTH_DEFAULT,
    RESPONSE_BODY_LENGTH_MAX,
} = require("../../src/util");
const {
    ping,
    checkCertificate,
    checkStatusCode,
    getTotalClientInRoom,
    httpNtlm,
    radius,
    kafkaProducerAsync,
    getOidcTokenClientCredentials,
    rootCertificatesFingerprints,
    axiosAbortSignal,
    checkCertificateHostname,
    encodeBase64,
    checkCertExpiryNotifications,
} = require("../util-server");
const { R } = require("redbean-node");
const { BeanModel } = require("redbean-node/dist/bean-model");
const { Notification } = require("../notification");
const IncidentTracker = require("../incident-tracker");
const { Proxy } = require("../proxy");
const { demoMode } = require("../config");
const version = require("../../package.json").version;
const apicache = require("../modules/apicache");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const { DockerHost } = require("../docker");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { UptimeCalculator } = require("../uptime-calculator");
const { CookieJar } = require("tough-cookie");
const { HttpsCookieAgent } = require("http-cookie-agent/http");
const https = require("https");
const http = require("http");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const brotliCompress = promisify(zlib.brotliCompress);
const DomainExpiry = require("./domain_expiry");

const rootCertificates = rootCertificatesFingerprints();

/**
 * status:
 *      0 = DOWN
 *      1 = UP
 *      2 = PENDING
 *      3 = MAINTENANCE
 */

// Slow-ping alert thresholds. When a monitor's response time stays above
// SLOW_PING_THRESHOLD_MS continuously for SLOW_PING_DURATION_MS or longer,
// a notification is sent through the monitor's configured notification list.
// A second notification is sent when the response time drops back to a normal range
// threshold.
const SLOW_PING_THRESHOLD_MS = 1000;
const SLOW_PING_DURATION_MS = 5 * 60 * 1000;

// Per-monitor slow-ping tracking state. Lives outside the BeanModel instance
// because BeanModel class-fields shadow redbean-node's Proxy accessor and
// cannot be read back after assignment (see PR discussion of this fix).
// Persisted across server restarts via the monitor.slow_ping_start /
// monitor.slow_ping_alert_sent columns — see Monitor.start() and
// Monitor.checkSlowPingAlert for the load/save wiring.
const slowPingState = new Map();
const downState = new Map();

/**
 * Pending deferred DOWN notifications, keyed by monitor ID. The value
 * is { timer, decision } — `timer` is the setTimeout handle and
 * `decision` is the IncidentTracker.handleDown decision that produced it.
 * Used by Monitor.scheduleDeferredNotification to deduplicate overlapping
 * deferrals for the same monitor (the latest defer window supersedes
 * earlier ones).
 */
const pendingDeferredNotifications = new Map();

/**
 * Maximum number of times a deferred DOWN notification may be re-deferred
 * because the parent's latest heartbeat looks stale (its check still in
 * flight). Bounds how long an orphaned child waits before firing its
 * standalone notification when the parent never records a DOWN.
 */
const MAX_DEFER_RECHECKS = 2;

/**
 * Get (or lazily initialise) the in-memory down-escalation state for a monitor.
 * @param {number} monitorID Monitor ID
 * @returns {{downStart: ?number, downAlertLevel: number}} Mutable state object
 */
function getDownState(monitorID) {
    let s = downState.get(monitorID);
    if (!s) {
        s = {
            downStart: null,
            downAlertLevel: 0, // 0 = none, 1 = developer/legacy notified, 2 = tech lead, 3 = admin
        };
        downState.set(monitorID, s);
    }
    return s;
}


/**
 * Get (or lazily initialise) the in-memory slow-ping state for a monitor.
 * @param {number} monitorID Monitor ID
 * @returns {{slowPingStart: ?number, slowPingAlertSent: boolean}} Mutable state object
 */
function getSlowPingState(monitorID) {
    let s = slowPingState.get(monitorID);
    if (!s) {
        s = {
            slowPingStart: null,
            slowPingAlertSent: false,
        };
        slowPingState.set(monitorID, s);
    }
    return s;
}

class Monitor extends BeanModel {
    /**
     * Return an object that ready to parse to JSON for public Only show
     * necessary data to public
     * @param {boolean} showTags Include tags in JSON
     * @param {boolean} certExpiry Include certificate expiry info in
     * JSON
     * @returns {Promise<object>} Object ready to parse
     */
    async toPublicJSON(showTags = false, certExpiry = false) {
        let obj = {
            id: this.id,
            name: this.name,
            sendUrl: this.sendUrl,
            type: this.type,
        };

        if (this.sendUrl) {
            obj.url = this.customUrl ?? this.url;
        }

        if (showTags) {
            obj.tags = await this.getTags();
        }

        if (certExpiry) {
            const { certExpiryDaysRemaining, validCert } = await this.getCertExpiry(this.id);
            obj.certExpiryDaysRemaining = certExpiryDaysRemaining;
            obj.validCert = validCert;
        }

        return obj;
    }

    /**
     * Return an object that ready to parse to JSON
     * @param {object} preloadData to prevent n+1 problems, we query the data in a batch outside of this function
     * @param {boolean} includeSensitiveData Include sensitive data in
     * JSON
     * @returns {object} Object ready to parse
     */
    toJSON(preloadData = {}, includeSensitiveData = true) {
        let screenshot = null;

        if (this.type === "real-browser") {
            screenshot = "/screenshots/" + jwt.sign(this.id, UptimeKumaServer.getInstance().jwtSecret) + ".png";
        }

        const path = preloadData.paths.get(this.id) || [];
        const pathName = path.join(" / ");

        let data = {
            id: this.id,
            name: this.name,
            description: this.description,
            path,
            pathName,
            parent: this.parent,
            childrenIDs: preloadData.childrenIDs.get(this.id) || [],
            url: this.url,
            wsIgnoreSecWebsocketAcceptHeader: this.getWsIgnoreSecWebsocketAcceptHeader(),
            wsSubprotocol: this.wsSubprotocol,
            method: this.method,
            hostname: this.hostname,
            port: this.port,
            location: this.location,
            protocol: this.protocol,
            maxretries: this.maxretries,
            weight: this.weight,
            active: preloadData.activeStatus.get(this.id),
            forceInactive: preloadData.forceInactive.get(this.id),
            groupNotifications: Boolean(this.group_notifications),
            type: this.type,
            subtype: this.subtype,
            timeout: this.timeout,
            interval: this.interval,
            retryInterval: this.retryInterval,
            retryOnlyOnStatusCodeFailure: Boolean(this.retry_only_on_status_code_failure),
            resendInterval: this.resendInterval,
            keyword: this.keyword,
            invertKeyword: this.isInvertKeyword(),
            expiryNotification: this.isEnabledExpiryNotification(),
            domainExpiryNotification: Boolean(this.domainExpiryNotification),
            ignoreTls: this.getIgnoreTls(),
            upsideDown: this.isUpsideDown(),
            packetSize: this.packetSize,
            maxredirects: this.maxredirects,
            accepted_statuscodes: this.getAcceptedStatuscodes(),
            dns_resolve_type: this.dns_resolve_type,
            dns_resolve_server: this.dns_resolve_server,
            dns_last_result: this.dns_last_result,
            docker_container: this.docker_container,
            docker_host: this.docker_host,
            proxyId: this.proxy_id,
            notificationIDList: preloadData.notifications.get(this.id) || {},
            tags: preloadData.tags.get(this.id) || [],
            maintenance: preloadData.maintenanceStatus.get(this.id),
            mqttTopic: this.mqttTopic,
            mqttSuccessMessage: this.mqttSuccessMessage,
            mqttCheckType: this.mqttCheckType,
            databaseQuery: this.databaseQuery,
            authMethod: this.authMethod,
            grpcUrl: this.grpcUrl,
            grpcProtobuf: this.grpcProtobuf,
            grpcMethod: this.grpcMethod,
            grpcServiceName: this.grpcServiceName,
            grpcEnableTls: this.getGrpcEnableTls(),
            radiusCalledStationId: this.radiusCalledStationId,
            radiusCallingStationId: this.radiusCallingStationId,
            game: this.game,
            gamedigGivenPortOnly: this.getGameDigGivenPortOnly(),
            httpBodyEncoding: this.httpBodyEncoding,
            jsonPath: this.jsonPath,
            expectedValue: this.expectedValue,
            system_service_name: this.system_service_name,
            kafkaProducerTopic: this.kafkaProducerTopic,
            kafkaProducerBrokers: JSON.parse(this.kafkaProducerBrokers),
            kafkaProducerSsl: this.getKafkaProducerSsl(),
            kafkaProducerAllowAutoTopicCreation: this.getKafkaProducerAllowAutoTopicCreation(),
            kafkaProducerMessage: this.kafkaProducerMessage,
            screenshot,
            cacheBust: this.getCacheBust(),
            remote_browser: this.remote_browser,
            screenshot_delay: this.screenshot_delay,
            snmpOid: this.snmpOid,
            jsonPathOperator: this.jsonPathOperator,
            snmpVersion: this.snmpVersion,
            smtpSecurity: this.smtpSecurity,
            rabbitmqNodes: JSON.parse(this.rabbitmqNodes),
            conditions: JSON.parse(this.conditions),
            ntpStratumThreshold: this.ntp_stratum_threshold,
            ntpTimeOffsetThreshold: this.ntp_time_offset_threshold,
            ntpRootDispersionThreshold: this.ntp_root_dispersion_threshold,
            ipFamily: this.ipFamily,
            expectedTlsAlert: this.expected_tls_alert,

            // ping advanced options
            ping_numeric: this.isPingNumeric(),
            ping_count: this.ping_count,
            ping_per_request_timeout: this.ping_per_request_timeout,

            // response saving options
            saveResponse: this.getSaveResponse(),
            saveErrorResponse: this.getSaveErrorResponse(),
            responseMaxLength: this.response_max_length ?? RESPONSE_BODY_LENGTH_DEFAULT,
        };

        if (includeSensitiveData) {
            data = {
                ...data,
                headers: this.headers,
                body: this.body,
                grpcBody: this.grpcBody,
                grpcMetadata: this.grpcMetadata,
                basic_auth_user: this.basic_auth_user,
                basic_auth_pass: this.basic_auth_pass,
                oauth_client_id: this.oauth_client_id,
                oauth_client_secret: this.oauth_client_secret,
                oauth_token_url: this.oauth_token_url,
                oauth_scopes: this.oauth_scopes,
                oauth_audience: this.oauth_audience,
                oauth_auth_method: this.oauth_auth_method,
                bearer_token: this.bearer_token,
                gamedigToken: this.gamedigToken,
                pushToken: this.pushToken,
                databaseConnectionString: this.databaseConnectionString,
                radiusUsername: this.radiusUsername,
                radiusPassword: this.radiusPassword,
                radiusSecret: this.radiusSecret,
                mqttUsername: this.mqttUsername,
                mqttPassword: this.mqttPassword,
                mqttWebsocketPath: this.mqttWebsocketPath,
                authWorkstation: this.authWorkstation,
                authDomain: this.authDomain,
                tlsCa: this.tlsCa,
                tlsCert: this.tlsCert,
                tlsKey: this.tlsKey,
                kafkaProducerSaslOptions: JSON.parse(this.kafkaProducerSaslOptions),
                rabbitmqUsername: this.rabbitmqUsername,
                rabbitmqPassword: this.rabbitmqPassword,
            };
        }

        data.includeSensitiveData = includeSensitiveData;
        return data;
    }

    /**
     * Get all tags applied to this monitor
     * @returns {Promise<LooseObject<any>[]>} List of tags on the
     * monitor
     */
    async getTags() {
        return await R.getAll(
            "SELECT mt.*, tag.name, tag.color FROM monitor_tag mt JOIN tag ON mt.tag_id = tag.id WHERE mt.monitor_id = ? ORDER BY tag.name",
            [this.id]
        );
    }

    /**
     * Gets certificate expiry for this monitor
     * @param {number} monitorID ID of monitor to send
     * @returns {Promise<LooseObject<any>>} Certificate expiry info for
     * monitor
     */
    async getCertExpiry(monitorID) {
        let tlsInfoBean = await R.findOne("monitor_tls_info", "monitor_id = ?", [monitorID]);
        let tlsInfo;
        if (tlsInfoBean) {
            tlsInfo = JSON.parse(tlsInfoBean?.info_json);
            if (tlsInfo?.valid && tlsInfo?.certInfo?.daysRemaining) {
                return {
                    certExpiryDaysRemaining: tlsInfo.certInfo.daysRemaining,
                    validCert: true,
                };
            }
        }
        return {
            certExpiryDaysRemaining: "",
            validCert: false,
        };
    }

    /**
     * Is the TLS expiry notification enabled?
     * @returns {boolean} Enabled?
     */
    isEnabledExpiryNotification() {
        return Boolean(this.expiryNotification);
    }

    /**
     * Check if ping should use numeric output only
     * @returns {boolean} True if IP addresses will be output instead of symbolic hostnames
     */
    isPingNumeric() {
        return Boolean(this.ping_numeric);
    }

    /**
     * Parse to boolean
     * @returns {boolean} Should TLS errors be ignored?
     */
    getIgnoreTls() {
        return Boolean(this.ignoreTls);
    }

    /**
     * Parse to boolean
     * @returns {boolean} Should WS headers be ignored?
     */
    getWsIgnoreSecWebsocketAcceptHeader() {
        return Boolean(this.wsIgnoreSecWebsocketAcceptHeader);
    }

    /**
     * Parse to boolean
     * @returns {boolean} Is the monitor in upside down mode?
     */
    isUpsideDown() {
        return Boolean(this.upsideDown);
    }

    /**
     * Parse to boolean
     * @returns {boolean} Invert keyword match?
     */
    isInvertKeyword() {
        return Boolean(this.invertKeyword);
    }

    /**
     * Parse to boolean
     * @returns {boolean} Enable TLS for gRPC?
     */
    getGrpcEnableTls() {
        return Boolean(this.grpcEnableTls);
    }

    /**
     * Parse to boolean
     * @returns {boolean} if cachebusting is enabled
     */
    getCacheBust() {
        return Boolean(this.cacheBust);
    }

    /**
     * Get accepted status codes
     * @returns {object} Accepted status codes
     */
    getAcceptedStatuscodes() {
        return JSON.parse(this.accepted_statuscodes_json);
    }

    /**
     * Get if game dig should only use the port which was provided
     * @returns {boolean} gamedig should only use the provided port
     */
    getGameDigGivenPortOnly() {
        return Boolean(this.gamedigGivenPortOnly);
    }

    /**
     * Parse to boolean
     * @returns {boolean} Kafka Producer Ssl enabled?
     */
    getKafkaProducerSsl() {
        return Boolean(this.kafkaProducerSsl);
    }

    /**
     * Parse to boolean
     * @returns {boolean} Kafka Producer Allow Auto Topic Creation Enabled?
     */
    getKafkaProducerAllowAutoTopicCreation() {
        return Boolean(this.kafkaProducerAllowAutoTopicCreation);
    }

    /**
     * Parse to boolean
     * @returns {boolean} Should save response data on success?
     */
    getSaveResponse() {
        return Boolean(this.save_response);
    }

    /**
     * Parse to boolean
     * @returns {boolean} Should save response data on error?
     */
    getSaveErrorResponse() {
        return Boolean(this.save_error_response);
    }

    /**
     * Start monitor
     * @param {Server} io Socket server instance
     * @returns {Promise<void>}
     */
    async start(io) {
        let previousBeat = null;
        let retries = 0;

        this.rootCertificates = rootCertificates;

        // Restore persisted slow-ping alert state from the DB columns, if any.
        // Without this, server restarts mid-slow-period would silently reset
        // the timer and miss the recovery notification.
        if (this.slowPingStart != null || this.slowPingAlertSent) {
            const state = getSlowPingState(this.id);
            state.slowPingStart = this.slowPingStart != null ? Number(this.slowPingStart) : null;
            state.slowPingAlertSent = Boolean(this.slowPingAlertSent);
            log.debug(
                "monitor",
                `[${this.name}] Restored slow-ping state: start=${state.slowPingStart} alertSent=${state.slowPingAlertSent}`
            );
        }

        // Restore persisted down-escalation state from the DB columns.
        // Without this, server restarts mid-escalation silently reset the
        // timer and re-fired already-delivered level-1/level-2 notifications.
        if (this.downStart != null || this.downAlertLevel > 0) {
            const downSt = getDownState(this.id);
            downSt.downStart = this.downStart != null ? Number(this.downStart) : null;
            downSt.downAlertLevel = Number(this.downAlertLevel) || 0;
            log.debug(
                "monitor",
                `[${this.name}] Restored down-escalation state: start=${downSt.downStart} level=${downSt.downAlertLevel}`
            );
        }

        try {
            this.prometheus = new Prometheus(this, await this.getTags());
        } catch (e) {
            log.error("prometheus", "Please submit an issue to our GitHub repo. Prometheus update error: ", e.message);
        }

        const beat = async () => {
            let beatInterval = this.interval;

            if (!beatInterval) {
                beatInterval = 1;
            }

            if (demoMode) {
                if (beatInterval < 20) {
                    console.log("beat interval too low, reset to 20s");
                    beatInterval = 20;
                }
            }

            // Expose here for prometheus update
            // undefined if not https
            let tlsInfo = undefined;

            if (!previousBeat || this.type === "push") {
                previousBeat = await R.findOne("heartbeat", " monitor_id = ? ORDER BY time DESC", [this.id]);
                if (previousBeat) {
                    retries = previousBeat.retries;
                }
            }

            const isFirstBeat = !previousBeat;

            let bean = R.dispense("heartbeat");
            bean.monitor_id = this.id;
            bean.time = R.isoDateTimeMillis(dayjs.utc());
            bean.status = DOWN;
            bean.downCount = previousBeat?.downCount || 0;

            if (this.isUpsideDown()) {
                bean.status = flipStatus(bean.status);
            }

            // Runtime patch timeout if it is 0
            // See https://github.com/louislam/uptime-kuma/pull/3961#issuecomment-1804149144
            if (!this.timeout || this.timeout <= 0) {
                this.timeout = this.interval * 1000 * 0.8;
            }

            try {
                if (await Monitor.isUnderMaintenance(this.id)) {
                    bean.msg = "Monitor under maintenance";
                    bean.status = MAINTENANCE;
                } else if (this.type === "http" || this.type === "keyword" || this.type === "json-query") {
                    // Do not do any queries/high loading things before the "bean.ping"
                    let startTime = dayjs().valueOf();

                    // HTTP basic auth
                    let basicAuthHeader = {};
                    if (this.auth_method === "basic") {
                        basicAuthHeader = {
                            Authorization: "Basic " + encodeBase64(this.basic_auth_user, this.basic_auth_pass),
                        };
                    }

                    // Bearer token auth
                    let bearerAuthHeader = {};
                    if (this.auth_method === "bearer") {
                        bearerAuthHeader = {
                            Authorization: "Bearer " + this.bearer_token,
                        };
                    }

                    // OIDC: Basic client credential flow.
                    // Additional grants might be implemented in the future
                    let oauth2AuthHeader = {};
                    if (this.auth_method === "oauth2-cc") {
                        try {
                            if (
                                this.oauthAccessToken === undefined ||
                                new Date(this.oauthAccessToken.expires_at * 1000) <= new Date()
                            ) {
                                this.oauthAccessToken = await this.makeOidcTokenClientCredentialsRequest();
                            }
                            oauth2AuthHeader = {
                                Authorization:
                                    this.oauthAccessToken.token_type + " " + this.oauthAccessToken.access_token,
                            };
                        } catch (e) {
                            throw new Error("The oauth config is invalid. " + e.message);
                        }
                    }

                    let agentFamily = undefined;
                    if (this.ipFamily === "ipv4") {
                        agentFamily = 4;
                    }
                    if (this.ipFamily === "ipv6") {
                        agentFamily = 6;
                    }

                    const httpsAgentOptions = {
                        maxCachedSessions: 0, // Use Custom agent to disable session reuse (https://github.com/nodejs/node/issues/3940)
                        rejectUnauthorized: !this.getIgnoreTls(),
                        secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
                        autoSelectFamily: true,
                        ...(agentFamily ? { family: agentFamily } : {}),
                    };

                    const httpAgentOptions = {
                        maxCachedSessions: 0,
                        autoSelectFamily: true,
                        ...(agentFamily ? { family: agentFamily } : {}),
                    };

                    log.debug("monitor", `[${this.name}] Prepare Options for axios`);

                    let contentType = null;
                    let bodyValue = null;

                    if (this.body && typeof this.body === "string" && this.body.trim().length > 0) {
                        if (!this.httpBodyEncoding || this.httpBodyEncoding === "json") {
                            try {
                                bodyValue = JSON.parse(this.body);
                                contentType = "application/json";
                            } catch (e) {
                                throw new Error("Your JSON body is invalid. " + e.message);
                            }
                        } else if (this.httpBodyEncoding === "form") {
                            bodyValue = this.body;
                            contentType = "application/x-www-form-urlencoded";
                        } else if (this.httpBodyEncoding === "xml") {
                            bodyValue = this.body;
                            contentType = "text/xml; charset=utf-8";
                        }
                    }

                    // Axios Options
                    const options = {
                        url: this.url,
                        method: (this.method || "get").toLowerCase(),
                        timeout: this.timeout * 1000,
                        headers: {
                            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.9",
                            ...(contentType ? { "Content-Type": contentType } : {}),
                            ...basicAuthHeader,
                            ...bearerAuthHeader,
                            ...oauth2AuthHeader,
                            ...(this.headers ? JSON.parse(this.headers) : {}),
                        },
                        maxRedirects: this.maxredirects,
                        validateStatus: (status) => {
                            return checkStatusCode(status, this.getAcceptedStatuscodes());
                        },
                        signal: axiosAbortSignal((this.timeout + 10) * 1000),
                    };

                    if (bodyValue) {
                        options.data = bodyValue;
                    }

                    if (this.cacheBust) {
                        const randomFloatString = Math.random().toString(36);
                        const cacheBust = randomFloatString.substring(2);
                        options.params = {
                            uptime_kuma_cachebuster: cacheBust,
                        };
                    }

                    if (this.proxy_id) {
                        const proxy = await R.load("proxy", this.proxy_id);

                        if (proxy && proxy.active) {
                            const { httpAgent, httpsAgent } = Proxy.createAgents(proxy, {
                                httpsAgentOptions: httpsAgentOptions,
                                httpAgentOptions: httpAgentOptions,
                            });

                            options.proxy = false;
                            options.httpAgent = httpAgent;
                            options.httpsAgent = httpsAgent;
                        }
                    }

                    if (!options.httpAgent) {
                        options.httpAgent = new http.Agent(httpAgentOptions);
                    }

                    if (!options.httpsAgent) {
                        let jar = new CookieJar();
                        let httpsCookieAgentOptions = {
                            ...httpsAgentOptions,
                            cookies: { jar },
                        };
                        options.httpsAgent = new HttpsCookieAgent(httpsCookieAgentOptions);
                    }

                    if (this.auth_method === "mtls") {
                        if (this.tlsCert !== null && this.tlsCert !== "") {
                            options.httpsAgent.options.cert = Buffer.from(this.tlsCert);
                        }
                        if (this.tlsCa !== null && this.tlsCa !== "") {
                            options.httpsAgent.options.ca = Buffer.from(this.tlsCa);
                        }
                        if (this.tlsKey !== null && this.tlsKey !== "") {
                            options.httpsAgent.options.key = Buffer.from(this.tlsKey);
                        }
                    }

                    let tlsInfo = {};
                    // Store tlsInfo when secureConnect event is emitted
                    // The keylog event listener is a workaround to access the tlsSocket
                    options.httpsAgent.once("keylog", async (line, tlsSocket) => {
                        tlsSocket.once("secureConnect", async () => {
                            tlsInfo = checkCertificate(tlsSocket);
                            tlsInfo.valid = tlsSocket.authorized || false;
                            tlsInfo.hostnameMatchMonitorUrl = checkCertificateHostname(
                                tlsInfo.certInfo.raw,
                                this.getUrl()?.hostname
                            );

                            await this.handleTlsInfo(tlsInfo);
                        });
                    });

                    log.debug("monitor", `[${this.name}] Axios Options: ${JSON.stringify(options)}`);
                    log.debug("monitor", `[${this.name}] Axios Request`);

                    // Make Request
                    let res = await this.makeAxiosRequest(options);

                    bean.msg = `${res.status} - ${res.statusText}`;
                    bean.ping = dayjs().valueOf() - startTime;

                    // in the frontend, the save response is only shown if the saveErrorResponse is set
                    if (this.getSaveResponse() && this.getSaveErrorResponse()) {
                        await this.saveResponseData(bean, res.data);
                    }

                    // fallback for if kelog event is not emitted, but we may still have tlsInfo,
                    // e.g. if the connection is made through a proxy
                    if (this.getUrl()?.protocol === "https:" && tlsInfo.valid === undefined) {
                        const tlsSocket = res.request.res.socket;

                        if (tlsSocket) {
                            tlsInfo = checkCertificate(tlsSocket);
                            tlsInfo.valid = tlsSocket.authorized || false;
                            tlsInfo.hostnameMatchMonitorUrl = checkCertificateHostname(
                                tlsInfo.certInfo.raw,
                                this.getUrl()?.hostname
                            );

                            await this.handleTlsInfo(tlsInfo);
                        }
                    }

                    // eslint-disable-next-line eqeqeq
                    if (process.env.UPTIME_KUMA_LOG_RESPONSE_BODY_MONITOR_ID == this.id) {
                        log.info("monitor", res.data);
                    }

                    if (this.type === "http") {
                        bean.status = UP;
                    } else if (this.type === "keyword") {
                        let data = res.data;

                        // Convert to string for object/array
                        if (typeof data !== "string") {
                            data = JSON.stringify(data);
                        }

                        let keywordFound = data.includes(this.keyword);
                        if (keywordFound === !this.isInvertKeyword()) {
                            bean.msg += ", keyword " + (keywordFound ? "is" : "not") + " found";
                            bean.status = UP;
                        } else {
                            data = data.replace(/<[^>]*>?|[\n\r]|\s+/gm, " ").trim();
                            if (data.length > 50) {
                                data = data.substring(0, 47) + "...";
                            }
                            throw new Error(
                                bean.msg +
                                    ", but keyword is " +
                                    (keywordFound ? "present" : "not") +
                                    " in [" +
                                    data +
                                    "]"
                            );
                        }
                    } else if (this.type === "json-query") {
                        let data = res.data;

                        const { status, response } = await evaluateJsonQuery(
                            data,
                            this.jsonPath,
                            this.jsonPathOperator,
                            this.expectedValue
                        );

                        if (status) {
                            bean.status = UP;
                            bean.msg = `JSON query passes (comparing ${response} ${this.jsonPathOperator} ${this.expectedValue})`;
                        } else {
                            throw new Error(
                                `JSON query does not pass (comparing ${response} ${this.jsonPathOperator} ${this.expectedValue})`
                            );
                        }
                    }
                } else if (this.type === "ping") {
                    bean.ping = await ping(
                        this.hostname,
                        this.ping_count,
                        "",
                        this.ping_numeric,
                        this.packetSize,
                        this.timeout,
                        this.ping_per_request_timeout
                    );
                    bean.msg = "";
                    bean.status = UP;
                } else if (this.type === "push") {
                    // Type: Push
                    log.debug(
                        "monitor",
                        `[${this.name}] Checking monitor at ${dayjs().format("YYYY-MM-DD HH:mm:ss.SSS")}`
                    );
                    const bufferTime = 1000; // 1s buffer to accommodate clock differences

                    if (previousBeat) {
                        const msSinceLastBeat = dayjs.utc().valueOf() - dayjs.utc(previousBeat.time).valueOf();

                        log.debug("monitor", `[${this.name}] msSinceLastBeat = ${msSinceLastBeat}`);

                        // If the previous beat was down or pending we use the regular
                        // beatInterval/retryInterval in the setTimeout further below
                        if (
                            previousBeat.status !== (this.isUpsideDown() ? DOWN : UP) ||
                            msSinceLastBeat > beatInterval * 1000 + bufferTime
                        ) {
                            bean.duration = Math.round(msSinceLastBeat / 1000);
                            throw new Error("No heartbeat in the time window");
                        } else {
                            let timeout = beatInterval * 1000 - msSinceLastBeat;
                            if (timeout < 0) {
                                timeout = bufferTime;
                            } else {
                                timeout += bufferTime;
                            }
                            // No need to insert successful heartbeat for push type, so end here
                            retries = 0;
                            log.debug("monitor", `[${this.name}] timeout = ${timeout}`);
                            this.heartbeatInterval = setTimeout(safeBeat, timeout);
                            return;
                        }
                    } else {
                        bean.duration = beatInterval;
                        throw new Error("No heartbeat in the time window");
                    }
                } else if (this.type === "docker") {
                    log.debug("monitor", `[${this.name}] Prepare Options for Axios`);

                    const options = {
                        url: `/containers/${this.docker_container}/json`,
                        timeout: this.interval * 1000 * 0.8,
                        headers: {
                            Accept: "*/*",
                        },
                        httpsAgent: new https.Agent({
                            maxCachedSessions: 0, // Use Custom agent to disable session reuse (https://github.com/nodejs/node/issues/3940)
                            rejectUnauthorized: !this.getIgnoreTls(),
                            secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
                        }),
                        httpAgent: new http.Agent({
                            maxCachedSessions: 0,
                        }),
                    };

                    const dockerHost = await R.load("docker_host", this.docker_host);

                    if (!dockerHost) {
                        throw new Error("Failed to load docker host config");
                    }

                    if (dockerHost._dockerType === "socket") {
                        options.socketPath = dockerHost._dockerDaemon;
                    } else if (dockerHost._dockerType === "tcp") {
                        options.baseURL = DockerHost.patchDockerURL(dockerHost._dockerDaemon);
                        options.httpsAgent = new https.Agent(
                            await DockerHost.getHttpsAgentOptions(dockerHost._dockerType, options.baseURL)
                        );
                    }

                    log.debug("monitor", `[${this.name}] Axios Request`);
                    let res = await axios.request(options);

                    if (!res.data.State) {
                        throw Error("Container state is not available");
                    }
                    if (!res.data.State.Running) {
                        throw Error("Container State is " + res.data.State.Status);
                    }
                    if (res.data.State.Paused) {
                        throw Error("Container is in a paused state");
                    }
                    if (res.data.State.Restarting) {
                        bean.status = PENDING;
                        bean.msg = "Container is reporting it is currently restarting";
                    } else if (res.data.State.Health && res.data.State.Health.Status !== "none") {
                        // if healthchecks are disabled (?), Health MAY not be present
                        if (res.data.State.Health.Status === "healthy") {
                            bean.status = UP;
                            bean.msg = "healthy";
                        } else if (res.data.State.Health.Status === "unhealthy") {
                            throw Error("Container State is unhealthy according to its healthcheck");
                        } else {
                            bean.status = PENDING;
                            bean.msg = res.data.State.Health.Status;
                        }
                    } else {
                        bean.status = UP;
                        bean.msg = `Container has not reported health and is currently ${res.data.State.Status}. As it is running, it is considered UP. Consider adding a health check for better service visibility`;
                    }
                } else if (this.type === "radius") {
                    let startTime = dayjs().valueOf();

                    // Handle monitors that were created before the
                    // update and as such don't have a value for
                    // this.port.
                    let port;
                    if (this.port == null) {
                        port = 1812;
                    } else {
                        port = this.port;
                    }

                    const resp = await radius(
                        this.hostname,
                        this.radiusUsername,
                        this.radiusPassword,
                        this.radiusCalledStationId,
                        this.radiusCallingStationId,
                        this.radiusSecret,
                        port,
                        this.interval * 1000 * 0.4
                    );

                    bean.msg = resp.code;
                    bean.status = UP;
                    bean.ping = dayjs().valueOf() - startTime;
                } else if (this.type in UptimeKumaServer.monitorTypeList) {
                    let startTime = dayjs().valueOf();
                    const monitorType = UptimeKumaServer.monitorTypeList[this.type];
                    await monitorType.check(this, bean, UptimeKumaServer.getInstance());

                    if (!monitorType.allowCustomStatus && bean.status !== UP) {
                        throw new Error(
                            "The monitor implementation is incorrect, non-UP error must throw error inside check()"
                        );
                    }

                    if (bean.ping === undefined || bean.ping === null) {
                        bean.ping = dayjs().valueOf() - startTime;
                    }
                } else if (this.type === "kafka-producer") {
                    let startTime = dayjs().valueOf();

                    bean.msg = await kafkaProducerAsync(
                        JSON.parse(this.kafkaProducerBrokers),
                        this.kafkaProducerTopic,
                        this.kafkaProducerMessage,
                        {
                            allowAutoTopicCreation: this.kafkaProducerAllowAutoTopicCreation,
                            ssl: this.kafkaProducerSsl,
                            clientId: `Uptime-Kuma/${version}`,
                            interval: this.interval,
                            connectionTimeout: this.timeout,
                        },
                        JSON.parse(this.kafkaProducerSaslOptions)
                    );
                    bean.status = UP;
                    bean.ping = dayjs().valueOf() - startTime;
                } else {
                    throw new Error("Unknown Monitor Type");
                }

                if (this.isUpsideDown()) {
                    bean.status = flipStatus(bean.status);

                    if (bean.status === DOWN) {
                        throw new Error("Flip UP to DOWN");
                    }
                }

                retries = 0;
            } catch (error) {
                if (error?.name === "CanceledError") {
                    bean.msg = `timeout by AbortSignal (${this.timeout}s)`;
                } else {
                    bean.msg = error.message;
                }

                if (this.getSaveErrorResponse() && error?.response?.data !== undefined) {
                    await this.saveResponseData(bean, error.response.data);
                }

                // If UP come in here, it must be upside down mode
                // Just reset the retries
                if (this.isUpsideDown() && bean.status === UP) {
                    retries = 0;
                } else if (this.type === "json-query" && this.retry_only_on_status_code_failure) {
                    // For json-query monitors with retry_only_on_status_code_failure enabled,
                    // only retry if the error is NOT from JSON query evaluation
                    // JSON query errors have the message "JSON query does not pass..."
                    const isJsonQueryError =
                        typeof error.message === "string" && error.message.includes("JSON query does not pass");

                    if (isJsonQueryError) {
                        // Don't retry on JSON query failures, mark as DOWN immediately
                        retries = 0;
                    } else if (this.maxretries > 0 && retries < this.maxretries) {
                        retries++;
                        bean.status = PENDING;
                    } else {
                        // Continue counting retries during DOWN
                        retries++;
                    }
                } else {
                    // General retry logic for all other monitor types
                    if (this.maxretries > 0 && retries < this.maxretries) {
                        retries++;
                        bean.status = PENDING;
                    } else {
                        // Continue counting retries during DOWN
                        retries++;
                    }
                }
            }

            bean.retries = retries;

            log.debug("monitor", `[${this.name}] Check isImportant`);
            let isImportant = Monitor.isImportantBeat(isFirstBeat, previousBeat?.status, bean.status);

            // The importance flag is part of the stored heartbeat row, so set
            // it before persisting.
            bean.important = isImportant;

            // Calculate uptime before storing so end_time is persisted with
            // the row.
            let uptimeCalculator = await UptimeCalculator.getUptimeCalculator(this.id);
            let endTimeDayjs = await uptimeCalculator.update(bean.status, parseFloat(bean.ping));
            bean.end_time = R.isoDateTimeMillis(endTimeDayjs);

            // Store the heartbeat BEFORE dispatching notifications. The
            // incident-grouping defer logic in child monitors reads the
            // parent's latest stored heartbeat to decide whether to stay
            // silent — if the parent's DOWN row only landed after its (slow)
            // Telegram delivery, children mistook the parent for UP and
            // fired their own duplicate notifications.
            log.debug("monitor", `[${this.name}] Store`);
            await R.store(bean);

            // True when the incident grouping withheld this beat's notification
            // (child folded into a parent incident). Forwarded on the socket
            // payload so the UI records the beat but skips the duplicate popup
            // toast for the root-cause alert.
            let incidentSuppressed = false;

            // Mark as important if status changed, ignore pending pings,
            // Don't notify if disrupted changes to up
            if (isImportant) {
                if (Monitor.isImportantForNotification(isFirstBeat, previousBeat?.status, bean.status)) {
                    log.debug("monitor", `[${this.name}] sendNotification`);
                    incidentSuppressed = await Monitor.sendNotification(isFirstBeat, this, bean);
                } else {
                    log.debug(
                        "monitor",
                        `[${this.name}] will not sendNotification because it is (or was) under maintenance`
                    );
                }

                // Reset down count
                bean.downCount = 0;

                // Clear Status Page Cache
                log.debug("monitor", `[${this.name}] apicache clear`);
                apicache.clear();

                await UptimeKumaServer.getInstance().sendMaintenanceListByUserID(this.user_id);
            } else {
                if (bean.status === DOWN && this.resendInterval > 0) {
                    ++bean.downCount;
                    if (bean.downCount >= this.resendInterval) {
                        // Send notification again, because we are still DOWN
                        log.debug(
                            "monitor",
                            `[${this.name}] sendNotification again: Down Count: ${bean.downCount} | Resend Interval: ${this.resendInterval}`
                        );
                        await Monitor.sendNotification(isFirstBeat, this, bean);

                        // Reset down count
                        bean.downCount = 0;
                    }
                }

                // Root-cause incident grouping: when this monitor is the
                // root of an incident whose consolidated DOWN notification
                // has not yet been dispatched (e.g., a child folded in
                // AFTER this monitor's UP→DOWN beat), fire it now. Keeps
                // the trigger on the root-cause monitor rather than on
                // whichever dependent beats first, and works even when
                // resendInterval is 0 (DOWN→DOWN beats never call
                // sendNotification on their own).
                if (bean.status === DOWN) {
                    await Monitor.maybeFirePendingIncident(this, bean);
                }
            }

            // Track sustained slow-ping periods and fire notifications via
            // the monitor's configured notification list when the response
            // time stays above SLOW_PING_THRESHOLD_MS for SLOW_PING_DURATION_MS.
            // Independent of UP/DOWN so a slow service that eventually times
            // out still alerts.
            await Monitor.checkSlowPingAlert(this, bean);

            // Check DOWN escalation state machine (developer -> tech lead -> admin)
            await Monitor.checkDownEscalation(this, bean);

            if (bean.status !== MAINTENANCE && Boolean(this.domainExpiryNotification)) {
                try {
                    const supportInfo = await DomainExpiry.checkSupport(this);
                    const domainExpiryDate = await DomainExpiry.checkExpiry(supportInfo.domain);
                    if (domainExpiryDate) {
                        DomainExpiry.sendNotifications(
                            supportInfo.domain,
                            (await Monitor.getNotificationList(this)) || []
                        );
                    } else {
                        log.debug("monitor", `Failed getting expiration date for domain ${supportInfo.domain}`);
                    }
                } catch (error) {
                    if (
                        error.message === "domain_expiry_unsupported_unsupported_tld_no_rdap_endpoint" &&
                        Boolean(this.domainExpiryNotification)
                    ) {
                        log.warn(
                            "domain_expiry",
                            `Domain expiry unsupported for '.${error.meta.publicSuffix}' because it lacks an RDAP endpoint in the IANA database. This isn’t an Uptime Kuma bug, a limitation of your registry. If an RDAP server exists, ask your registrar politely to submit it to IANA so expiry checks can work.`
                        );
                    }
                }
            }

            if (bean.status === UP) {
                log.debug(
                    "monitor",
                    `Monitor #${this.id} '${this.name}': Successful Response: ${bean.ping} ms | Interval: ${beatInterval} seconds | Type: ${this.type}`
                );
            } else if (bean.status === PENDING) {
                if (this.retryInterval > 0) {
                    beatInterval = this.retryInterval;
                }
                log.warn(
                    "monitor",
                    `Monitor #${this.id} '${this.name}': Pending: ${bean.msg} | Max retries: ${this.maxretries} | Retry: ${retries} | Retry Interval: ${beatInterval} seconds | Type: ${this.type}`
                );
            } else if (bean.status === MAINTENANCE) {
                log.warn("monitor", `Monitor #${this.id} '${this.name}': Under Maintenance | Type: ${this.type}`);
            } else {
                log.warn(
                    "monitor",
                    `Monitor #${this.id} '${this.name}': Failing: ${bean.msg} | Interval: ${beatInterval} seconds | Type: ${this.type} | Down Count: ${bean.downCount} | Resend Interval: ${this.resendInterval}`
                );
            }

            // Send to frontend
            log.debug("monitor", `[${this.name}] Send to socket`);
            const heartbeatData = bean.toJSON();
            if (incidentSuppressed) {
                // This beat's notification was folded into the root-cause
                // incident alert — the UI should not pop a duplicate toast.
                heartbeatData.incidentSuppressed = true;
            }
            io.to(this.user_id).emit("heartbeat", heartbeatData);
            Monitor.sendStats(io, this.id, this.user_id);

            log.debug("monitor", `[${this.name}] prometheus.update`);
            const data24h = uptimeCalculator.get24Hour();
            const data30d = uptimeCalculator.get30Day();
            const data1y = uptimeCalculator.get1Year();
            this.prometheus?.update(bean, tlsInfo, { data24h, data30d, data1y });

            previousBeat = bean;

            if (!this.isStop) {
                log.debug("monitor", `[${this.name}] SetTimeout for next check.`);

                let intervalRemainingMs = Math.max(1, beatInterval * 1000 - dayjs().diff(dayjs.utc(bean.time)));

                log.debug("monitor", `[${this.name}] Next heartbeat in: ${intervalRemainingMs}ms`);

                this.heartbeatInterval = setTimeout(safeBeat, intervalRemainingMs);
            } else {
                log.info("monitor", `[${this.name}] isStop = true, no next check.`);
            }
        };

        /**
         * Get a heartbeat and handle errors7
         * @returns {void}
         */
        const safeBeat = async () => {
            try {
                await beat();
            } catch (e) {
                console.trace(e);
                UptimeKumaServer.errorLog(e, false);
                log.error("monitor", "Please report to https://github.com/louislam/uptime-kuma/issues");

                if (!this.isStop) {
                    log.info("monitor", "Try to restart the monitor");
                    this.heartbeatInterval = setTimeout(safeBeat, this.interval * 1000);
                }
            }
        };

        // Delay Push Type
        if (this.type === "push") {
            this.heartbeatInterval = setTimeout(() => {
                safeBeat();
            }, this.interval * 1000);
        } else {
            safeBeat();
        }
    }

    /**
     * Save response body to a heartbeat if response saving is enabled.
     * @param {import("redbean-node").Bean} bean Heartbeat bean to populate.
     * @param {unknown} data Response payload.
     * @returns {void}
     */
    async saveResponseData(bean, data) {
        if (data === undefined) {
            return;
        }

        let responseData = data;
        if (typeof responseData !== "string") {
            try {
                responseData = JSON.stringify(responseData);
            } catch (error) {
                responseData = String(responseData);
            }
        }

        const maxSize = this.response_max_length ?? RESPONSE_BODY_LENGTH_DEFAULT;
        if (responseData.length > maxSize) {
            responseData = responseData.substring(0, maxSize) + "... (truncated)";
        }

        // Offload brotli compression from main event loop to libuv thread pool
        bean.response = (await brotliCompress(Buffer.from(responseData, "utf8"))).toString("base64");
    }

    /**
     * Make a request using axios
     * @param {object} options Options for Axios
     * @param {boolean} finalCall Should this be the final call i.e
     * don't retry on failure
     * @returns {object} Axios response
     */
    async makeAxiosRequest(options, finalCall = false) {
        try {
            let res;
            if (this.auth_method === "ntlm") {
                options.httpsAgent.keepAlive = true;
                options.httpAgent.keepAlive = true;

                res = await httpNtlm(options, {
                    username: this.basic_auth_user,
                    password: this.basic_auth_pass,
                    domain: this.authDomain,
                    workstation: this.authWorkstation ? this.authWorkstation : undefined,
                });
            } else {
                res = await axios.request(options);
            }

            return res;
        } catch (error) {
            /**
             * Make a single attempt to obtain an new access token in the event that
             * the recent api request failed for authentication purposes
             */
            if (this.auth_method === "oauth2-cc" && error.response.status === 401 && !finalCall) {
                this.oauthAccessToken = await this.makeOidcTokenClientCredentialsRequest();
                let oauth2AuthHeader = {
                    Authorization: this.oauthAccessToken.token_type + " " + this.oauthAccessToken.access_token,
                };
                options.headers = { ...options.headers, ...oauth2AuthHeader };

                return this.makeAxiosRequest(options, true);
            }

            // Fix #2253
            // Read more: https://stackoverflow.com/questions/1759956/curl-error-18-transfer-closed-with-outstanding-read-data-remaining
            if (
                !finalCall &&
                typeof error.message === "string" &&
                error.message.includes("maxContentLength size of -1 exceeded")
            ) {
                log.debug("monitor", "makeAxiosRequest with gzip");
                options.headers["Accept-Encoding"] = "gzip, deflate";
                return this.makeAxiosRequest(options, true);
            } else {
                if (
                    typeof error.message === "string" &&
                    error.message.includes("maxContentLength size of -1 exceeded")
                ) {
                    error.message = "response timeout: incomplete response within a interval";
                }
                throw error;
            }
        }
    }

    /**
     * Stop monitor
     * @returns {Promise<void>}
     */
    async stop() {
        clearTimeout(this.heartbeatInterval);
        this.isStop = true;

        // Cancel any pending deferred DOWN notification so we don't send a
        // stray alert after the monitor is stopped.
        const pending = pendingDeferredNotifications.get(this.id);
        if (pending) {
            clearTimeout(pending.timer);
            pendingDeferredNotifications.delete(this.id);
        }

        this.prometheus?.remove();
    }

    /**
     * Get prometheus instance
     * @returns {Prometheus|undefined} Current prometheus instance
     */
    getPrometheus() {
        return this.prometheus;
    }

    /**
     * Helper Method:
     * returns URL object for further usage
     * returns null if url is invalid
     * @returns {(null|URL)} Monitor URL
     */
    getUrl() {
        try {
            return new URL(this.url);
        } catch (_) {
            return null;
        }
    }

    /**
     * Example: http: or https:
     * @returns {(null|string)} URL's protocol
     */
    getURLProtocol() {
        const url = this.getUrl();
        if (url) {
            return this.getUrl().protocol;
        } else {
            return null;
        }
    }

    /**
     * Store TLS info to database
     * @param {object} checkCertificateResult Certificate to update
     * @returns {Promise<object>} Updated certificate
     */
    async updateTlsInfo(checkCertificateResult) {
        let tlsInfoBean = await R.findOne("monitor_tls_info", "monitor_id = ?", [this.id]);

        if (tlsInfoBean == null) {
            tlsInfoBean = R.dispense("monitor_tls_info");
            tlsInfoBean.monitor_id = this.id;
        } else {
            // Clear sent history if the cert changed.
            try {
                let oldCertInfo = JSON.parse(tlsInfoBean.info_json);

                let isValidObjects =
                    oldCertInfo && oldCertInfo.certInfo && checkCertificateResult && checkCertificateResult.certInfo;

                if (isValidObjects) {
                    if (oldCertInfo.certInfo.fingerprint256 !== checkCertificateResult.certInfo.fingerprint256) {
                        log.debug("monitor", "Resetting sent_history");
                        await R.exec(
                            "DELETE FROM notification_sent_history WHERE type = 'certificate' AND monitor_id = ?",
                            [this.id]
                        );
                    } else {
                        log.debug("monitor", "No need to reset sent_history");
                        log.debug("monitor", oldCertInfo.certInfo.fingerprint256);
                        log.debug("monitor", checkCertificateResult.certInfo.fingerprint256);
                    }
                } else {
                    log.debug("monitor", "Not valid object");
                }
            } catch (e) {}
        }

        tlsInfoBean.info_json = JSON.stringify(checkCertificateResult);
        await R.store(tlsInfoBean);

        return checkCertificateResult;
    }

    /**
     * Checks if the monitor is active based on itself and its parents
     * @param {number} monitorID ID of monitor to send
     * @param {boolean} active is active
     * @returns {Promise<boolean>} Is the monitor active?
     */
    static async isActive(monitorID, active) {
        const parentActive = await Monitor.isParentActive(monitorID);

        return active === 1 && parentActive;
    }

    /**
     * Send statistics to clients
     * @param {Server} io Socket server instance
     * @param {number} monitorID ID of monitor to send
     * @param {number} userID ID of user to send to
     * @returns {void}
     */
    static async sendStats(io, monitorID, userID) {
        const hasClients = getTotalClientInRoom(io, userID) > 0;
        let uptimeCalculator = await UptimeCalculator.getUptimeCalculator(monitorID);

        if (hasClients) {
            // Send 24 hour average ping
            let data24h = await uptimeCalculator.get24Hour();
            io.to(userID).emit("avgPing", monitorID, data24h.avgPing ? Number(data24h.avgPing.toFixed(2)) : null);

            // Send 24 hour uptime
            io.to(userID).emit("uptime", monitorID, 24, data24h.uptime);

            // Send 30 day uptime
            let data30d = await uptimeCalculator.get30Day();
            io.to(userID).emit("uptime", monitorID, 720, data30d.uptime);

            // Send 1-year uptime
            let data1y = await uptimeCalculator.get1Year();
            io.to(userID).emit("uptime", monitorID, "1y", data1y.uptime);

            // Send Cert Info
            await Monitor.sendCertInfo(io, monitorID, userID);

            // Send domain info
            await Monitor.sendDomainInfo(io, monitorID, userID);
        } else {
            log.debug("monitor", "No clients in the room, no need to send stats");
        }
    }

    /**
     * Send certificate information to client
     * @param {Server} io Socket server instance
     * @param {number} monitorID ID of monitor to send
     * @param {number} userID ID of user to send to
     * @returns {void}
     */
    static async sendCertInfo(io, monitorID, userID) {
        let tlsInfo = await R.findOne("monitor_tls_info", "monitor_id = ?", [monitorID]);
        if (tlsInfo != null) {
            io.to(userID).emit("certInfo", monitorID, tlsInfo.info_json);
        }
    }

    /**
     * Send domain name information to client
     * @param {Server} io Socket server instance
     * @param {number} monitorID ID of monitor to send
     * @param {number} userID ID of user to send to
     * @returns {void}
     */
    static async sendDomainInfo(io, monitorID, userID) {
        const monitor = await R.findOne("monitor", "id = ?", [monitorID]);

        try {
            const supportInfo = await DomainExpiry.checkSupport(monitor);
            const domain = await DomainExpiry.findByDomainNameOrCreate(supportInfo.domain);
            if (domain?.expiry) {
                io.to(userID).emit("domainInfo", monitorID, domain.daysRemaining, new Date(domain.expiry));
            }
        } catch (e) {}
    }

    /**
     * Has status of monitor changed since last beat?
     * @param {boolean} isFirstBeat Is this the first beat of this monitor?
     * @param {const} previousBeatStatus Status of the previous beat
     * @param {const} currentBeatStatus Status of the current beat
     * @returns {boolean} True if is an important beat else false
     */
    static isImportantBeat(isFirstBeat, previousBeatStatus, currentBeatStatus) {
        // * ? -> ANY STATUS = important [isFirstBeat]
        // UP -> PENDING = not important
        // * UP -> DOWN = important
        // UP -> UP = not important
        // PENDING -> PENDING = not important
        // * PENDING -> DOWN = important
        // PENDING -> UP = not important
        // DOWN -> PENDING = this case not exists
        // DOWN -> DOWN = not important
        // * DOWN -> UP = important
        // MAINTENANCE -> MAINTENANCE = not important
        // * MAINTENANCE -> UP = important
        // * MAINTENANCE -> DOWN = important
        // * DOWN -> MAINTENANCE = important
        // * UP -> MAINTENANCE = important
        return (
            isFirstBeat ||
            (previousBeatStatus === DOWN && currentBeatStatus === MAINTENANCE) ||
            (previousBeatStatus === UP && currentBeatStatus === MAINTENANCE) ||
            (previousBeatStatus === MAINTENANCE && currentBeatStatus === DOWN) ||
            (previousBeatStatus === MAINTENANCE && currentBeatStatus === UP) ||
            (previousBeatStatus === UP && currentBeatStatus === DOWN) ||
            (previousBeatStatus === DOWN && currentBeatStatus === UP) ||
            (previousBeatStatus === PENDING && currentBeatStatus === DOWN)
        );
    }

    /**
     * Is this beat important for notifications?
     * @param {boolean} isFirstBeat Is this the first beat of this monitor?
     * @param {const} previousBeatStatus Status of the previous beat
     * @param {const} currentBeatStatus Status of the current beat
     * @returns {boolean} True if is an important beat else false
     */
    static isImportantForNotification(isFirstBeat, previousBeatStatus, currentBeatStatus) {
        // * ? -> ANY STATUS = important [isFirstBeat]
        // UP -> PENDING = not important
        // * UP -> DOWN = important
        // UP -> UP = not important
        // PENDING -> PENDING = not important
        // * PENDING -> DOWN = important
        // PENDING -> UP = not important
        // DOWN -> PENDING = this case not exists
        // DOWN -> DOWN = not important
        // * DOWN -> UP = important
        // MAINTENANCE -> MAINTENANCE = not important
        // MAINTENANCE -> UP = not important
        // * MAINTENANCE -> DOWN = important
        // DOWN -> MAINTENANCE = not important
        // UP -> MAINTENANCE = not important
        return (
            isFirstBeat ||
            (previousBeatStatus === MAINTENANCE && currentBeatStatus === DOWN) ||
            (previousBeatStatus === UP && currentBeatStatus === DOWN) ||
            (previousBeatStatus === DOWN && currentBeatStatus === UP) ||
            (previousBeatStatus === PENDING && currentBeatStatus === DOWN)
        );
    }

    /**
     * Send a notification about a monitor
     * @param {boolean} isFirstBeat Is this beat the first of this monitor?
     * @param {Monitor} monitor The monitor to send a notification about
     * @param {import("./heartbeat")} bean Status information about monitor
     * @returns {Promise<boolean>} true when the incident grouping suppressed
     * this beat's notification (child folded into a parent incident). The
     * caller marks the socket payload so the UI records the beat without a
     * popup toast. Deferred beats are NOT suppressed — the child is down and
     * its popup shows immediately.
     */
    static async sendNotification(isFirstBeat, monitor, bean) {
        if (!isFirstBeat || bean.status === DOWN) {
            // Root-cause incident grouping: when a monitor opts in via
            // `groupNotifications`, this single hook decides whether the
            // notification is suppressed (covered by an existing incident),
            // consolidated (sent on behalf of the root-cause monitor), or
            // falls through to the standard per-monitor flow.
            if (bean.status === DOWN) {
                const decision = await IncidentTracker.handleDown(monitor);
                if (decision.send === "suppress") {
                    log.debug(
                        "monitor",
                        `[${monitor.name}] DOWN notification suppressed — covered by active incident for root monitor #${decision.rootMonitor?.id}`
                    );
                    return true;
                }
                if (decision.send === "incident-root") {
                    await Monitor.dispatchIncidentDown(bean, decision);
                    return false;
                }
                if (decision.send === "deferred") {
                    await Monitor.scheduleDeferredNotification(monitor, bean, decision);
                    // Deferred is NOT suppressed: the child IS down and its
                    // popup shows immediately. If the parent later folds it
                    // in, only the Telegram side stays silent; if the parent
                    // stays UP, the deferred re-fire delivers the standalone
                    // notification to match the popup.
                    return false;
                }
                // "standard" → fall through to the existing flow below
            } else if (bean.status === UP) {
                const decision = await IncidentTracker.handleUp(monitor);
                if (decision.send === "suppress") {
                    log.debug(
                        "monitor",
                        `[${monitor.name}] UP notification suppressed — affected monitor in active incident`
                    );
                    return true;
                }
                if (decision.send === "incident-resolved") {
                    await Monitor.dispatchIncidentUp(monitor, bean, decision);
                    return false;
                }
                // "standard" → fall through to the existing flow below
            }

            await Monitor.sendStandardNotification(monitor, bean);
        }
        return false;
    }

    /**
     * Run the standard (non-incident-grouped) per-monitor notification flow:
     * build the heartbeat envelope, apply escalation-level filtering for
     * DOWN events, format the message, and dispatch to the monitor's
     * notification list. Shared by sendNotification (synchronous path) and
     * scheduleDeferredNotification (re-fire after the defer window).
     * @param {Monitor} monitor The monitor to notify about
     * @param {import("./heartbeat")} bean Heartbeat that triggered the notification
     * @returns {Promise<void>}
     */
    static async sendStandardNotification(monitor, bean) {
        const fullNotificationList = await Monitor.getNotificationList(monitor);

        // If this is a DOWN event, only send immediate notifications to
        // legacy notifications (no escalationLevel in config) and those
        // explicitly marked as escalationLevel 1 (developer). Notifications
        // marked escalationLevel 2/3 will be sent later by the escalation
        // state machine.
        let notificationList = fullNotificationList;
        if (bean.status === DOWN) {
            notificationList = fullNotificationList.filter((n) => {
                try {
                    const cfg = JSON.parse(n.config || "{}");
                    // if escalationLevel is not set, treat as legacy -> include
                    if (cfg.escalationLevel === undefined || cfg.escalationLevel === null) {
                        return true;
                    }
                    const lvl = Number(cfg.escalationLevel);
                    // Defensive validation: only {1,2,3} are valid escalation
                    // tiers. Anything else (1.5, "foo", NaN, -1) is silently
                    // excluded from every tier today; warn and fall back to
                    // legacy/immediate so the user still receives the alert.
                    if (!Number.isInteger(lvl) || lvl < 1 || lvl > 3) {
                        log.warn(
                            "monitor",
                            `[${monitor.name}] Notification ${n.name} has invalid ` +
                                `escalationLevel=${JSON.stringify(cfg.escalationLevel)}; ` +
                                `treating as legacy/immediate.`
                        );
                        return true;
                    }
                    return lvl === 1;
                } catch (e) {
                    return true;
                }
            });
        }

        // If checkDownEscalation already sent a "✅ Recovered" message for
        // this UP beat, skip the plain "✅ Up" to avoid duplicate recovery
        // notifications. The recovery message carries the same info plus
        // the recovery duration.
        if (bean.status === UP && getDownState(monitor.id).recoveryFired) {
            log.debug(
                "monitor",
                `[${monitor.name}] Skipping standard UP notification — recovery summary already sent by checkDownEscalation`
            );
            return;
        }

        let text;
        if (bean.status === UP) {
            text = "✅ Up";
        } else {
            text = "🔴 Down";
        }

        let msg = `[${monitor.name}] [${text}] ${bean.msg}`;

        // When this monitor is the root of an active incident, append the
        // affected services list to the message. The list grows as more
        // children fold in over time, so each DOWN (or resend) reflects
        // the current blast radius.
        if (bean.status === DOWN) {
            msg = await Monitor.appendIncidentAffectedToMessage(monitor, msg);
        }

        const heartbeatJSON = await bean.toJSONAsync({ decodeResponse: true });
        // Prevent if the msg is undefined, notifications such as Discord cannot send out.
        if (!heartbeatJSON["msg"]) {
            heartbeatJSON["msg"] = "N/A";
        }

        // Also provide the time in server timezone
        heartbeatJSON["timezone"] = await UptimeKumaServer.getInstance().getTimezone();
        heartbeatJSON["timezoneOffset"] = UptimeKumaServer.getInstance().getTimezoneOffset();
        heartbeatJSON["localDateTime"] = dayjs
            .utc(heartbeatJSON["time"])
            .tz(heartbeatJSON["timezone"])
            .format(SQL_DATETIME_FORMAT);

        // Calculate downtime tracking information when service comes back up
        // This makes downtime information available to all notification providers
        if (bean.status === UP && monitor.id) {
            try {
                // Filter by important = 1 to get the state transition heartbeat (e.g. UP→DOWN),
                // not the most recent DOWN heartbeat which would be the last check before recovery.
                const lastDownHeartbeat = await R.getRow(
                    "SELECT time FROM heartbeat WHERE monitor_id = ? AND status = ? AND important = 1 ORDER BY time DESC LIMIT 1",
                    [monitor.id, DOWN]
                );

                if (lastDownHeartbeat && lastDownHeartbeat.time) {
                    heartbeatJSON["lastDownTime"] = lastDownHeartbeat.time;
                }
            } catch (error) {
                // If we can't calculate downtime, just continue without it
                // Silently fail to avoid disrupting notification sending
                log.debug(
                    "monitor",
                    `[${monitor.name}] Could not calculate downtime information: ${error.message}`
                );
            }
        }

        await Monitor.dispatchNotifications(monitor, notificationList, msg, heartbeatJSON);
    }

    /**
     * Re-evaluate the incident decision after `decision.deferMs` so the
     * parent has a chance to record its own DOWN transition. If the
     * parent has since gone DOWN, fold the child into the incident
     * silently. If the parent is still UP (genuine orphan), fire the
     * child's standalone DOWN notification via the standard path.
     *
     * Tracks pending deferred notifications per monitor so duplicate
     * DOWN beats on the same monitor do not schedule overlapping fires
     * (the latest defer window supersedes earlier ones).
     * @param {Monitor} monitor The monitor whose DOWN was deferred
     * @param {import("./heartbeat")} bean Heartbeat that triggered the original DOWN
     * @param {{rootMonitor: object, deferMs: number}} decision Decision from IncidentTracker.handleDown
     * @param {number} deferCount How many times this notification has
     * already been re-deferred waiting for the parent's status
     * @returns {Promise<void>}
     */
    static async scheduleDeferredNotification(monitor, bean, decision, deferCount = 0) {
        // Clear any earlier pending defer for this monitor — we want at
        // most one outstanding fire per monitor at any time.
        if (pendingDeferredNotifications.has(monitor.id)) {
            clearTimeout(pendingDeferredNotifications.get(monitor.id).timer);
        }
        log.debug(
            "monitor",
            `[${monitor.name}] DOWN notification deferred ${decision.deferMs}ms — re-checking parent status before firing`
        );

        const timer = setTimeout(async () => {
            pendingDeferredNotifications.delete(monitor.id);
            try {
                // Re-call handleDown with the same parent. If the parent
                // has since gone DOWN, this returns "suppress" and the
                // child folds into the incident silently. If the parent
                // is still UP, it returns "standard" and we fire the
                // child's standalone. It cannot return "deferred" again
                // because either parent is now DOWN (different branch) or
                // parent is still UP (same branch — but we want to fire
                // here, not defer again, so we check explicitly below).
                const newDecision = await IncidentTracker.handleDown(monitor, {
                    parent: decision.rootMonitor,
                });
                if (newDecision.send === "suppress" || newDecision.send === "incident-root") {
                    log.debug(
                        "monitor",
                        `[${monitor.name}] Deferred DOWN notification absorbed by parent incident after parent went DOWN`
                    );
                    return;
                }
                // Parent is still UP after the defer window. Before
                // declaring a genuine orphan, check whether the parent's
                // latest heartbeat is actually fresh. If its last beat is
                // older than one parent interval, the parent's current
                // check is most likely still in flight (typically hanging
                // on the same outage that took this child down) and its
                // DOWN transition simply has not been recorded yet —
                // re-defer instead of firing a premature duplicate
                // notification. After MAX_DEFER_RECHECKS attempts (or when
                // the parent goes fully stale), accept the orphan and fire.
                const parentID = decision.rootMonitor?.id;
                const parentInterval = decision.rootMonitor?.interval;
                if (parentID && deferCount < MAX_DEFER_RECHECKS) {
                    const lastBeatMs = await IncidentTracker.getLastBeatTimeMs(parentID);
                    const intervalMs = Math.max(Number(parentInterval) || 60, 20) * 1000;
                    if (lastBeatMs === null || Date.now() - lastBeatMs > intervalMs) {
                        log.debug(
                            "monitor",
                            `[${monitor.name}] Parent #${parentID} heartbeat is stale (check likely in flight) — re-deferring orphan notification (attempt ${deferCount + 1}/${MAX_DEFER_RECHECKS})`
                        );
                        const deferMs = await IncidentTracker.computeDeferWindowMs(parentID, parentInterval);
                        if (deferMs !== null) {
                            await Monitor.scheduleDeferredNotification(monitor, bean, { ...decision, deferMs }, deferCount + 1);
                            return;
                        }
                    }
                }
                // Parent is alive and checked UP recently → genuine
                // orphan failure. Fire the child's standalone DOWN.
                log.debug(
                    "monitor",
                    `[${monitor.name}] Deferred DOWN notification firing — parent still UP, child is orphan`
                );
                await Monitor.sendStandardNotification(monitor, bean);
            } catch (e) {
                log.error("monitor", `Deferred notification for [${monitor.name}] failed: ${e?.message || e}`);
            }
        }, decision.deferMs);

        pendingDeferredNotifications.set(monitor.id, { timer, decision });
    }

    /**
     * Build the same heartbeatJSON envelope that the standard notification
     * path constructs, so notification providers receive a uniform shape
     * regardless of whether the message is per-monitor or incident-grouped.
     * @param {import("./heartbeat")} bean Heartbeat that triggered the notification
     * @returns {Promise<object>}
     */
    static async buildHeartbeatJSON(bean) {
        const heartbeatJSON = await bean.toJSONAsync({ decodeResponse: true });
        if (!heartbeatJSON["msg"]) {
            heartbeatJSON["msg"] = "N/A";
        }
        heartbeatJSON["timezone"] = await UptimeKumaServer.getInstance().getTimezone();
        heartbeatJSON["timezoneOffset"] = UptimeKumaServer.getInstance().getTimezoneOffset();
        heartbeatJSON["localDateTime"] = dayjs
            .utc(heartbeatJSON["time"])
            .tz(heartbeatJSON["timezone"])
            .format(SQL_DATETIME_FORMAT);
        return heartbeatJSON;
    }

    /**
     * Apply the same escalation-level filter the standard DOWN path uses,
     * so the incident notification respects the legacy / level-1 only policy.
     * @param {Array} fullNotificationList
     * @returns {Array}
     */
    static filterImmediateDownNotifications(fullNotificationList) {
        return fullNotificationList.filter((n) => {
            try {
                const cfg = JSON.parse(n.config || "{}");
                if (cfg.escalationLevel === undefined || cfg.escalationLevel === null) {
                    return true;
                }
                return Number(cfg.escalationLevel) === 1;
            } catch (e) {
                return true;
            }
        });
    }

    /**
     * Dispatch a consolidated DOWN notification on behalf of the root-cause
     * monitor for an active incident. Sends the "🔴 Incident detected" message
     * to the root monitor's notification list (filtered to immediate tier).
     * @param {import("./heartbeat")} bean Heartbeat from the triggering child monitor
     * @param {{rootMonitor: object, affectedIds: number[]}} decision Decision from IncidentTracker.handleDown
     * @returns {Promise<void>}
     */
    static async dispatchIncidentDown(bean, decision) {
        const rootMonitor = decision.rootMonitor;
        const rootFullList = await Monitor.getNotificationList(rootMonitor);
        const rootNotificationList = Monitor.filterImmediateDownNotifications(rootFullList);

        if (rootNotificationList.length === 0) {
            log.debug(
                "monitor",
                `[${rootMonitor.name}] No immediate-tier notifications configured for root cause — incident consolidated notification skipped.`
            );
            return;
        }

        const affectedIDs = (decision.affectedIds || []).filter((id) => id !== rootMonitor.id);
        const affectedMap = await IncidentTracker.getMonitorsByIDs(affectedIDs);
        const affectedMonitors = affectedIDs.map((id) => affectedMap.get(id)).filter(Boolean);

        const msg = IncidentTracker.formatIncidentDownMessage(
            rootMonitor.name,
            bean.msg || "unavailable",
            affectedMonitors
        );

        const heartbeatJSON = await Monitor.buildHeartbeatJSON(bean);
        heartbeatJSON.isIncident = true;
        heartbeatJSON.incidentRootMonitorId = rootMonitor.id;
        heartbeatJSON.incidentAffectedIds = affectedIDs;

        log.debug(
            "monitor",
            `[Incident] Sending consolidated DOWN notification for root monitor #${rootMonitor.id} (${rootMonitor.name}) affecting ${affectedIDs.length} service(s)`
        );

        await Monitor.dispatchNotifications(rootMonitor, rootNotificationList, msg, heartbeatJSON);
    }

    /**
     * Dispatch a consolidated UP notification when the root-cause monitor of
     * an active incident recovers. Lists any still-affected children.
     * @param {Monitor} monitor The recovering root monitor
     * @param {import("./heartbeat")} bean Heartbeat that triggered the recovery
     * @param {{rootMonitor: object, stillAffectedIds: number[]}} decision Decision from IncidentTracker.handleUp
     * @returns {Promise<void>}
     */
    static async dispatchIncidentUp(monitor, bean, decision) {
        // The root monitor's own notification list is used so the operator's
        // existing channels receive the recovery alert.
        const fullNotificationList = await Monitor.getNotificationList(monitor);
        if (fullNotificationList.length === 0) {
            log.debug(
                "monitor",
                `[Incident] No notifications configured for root monitor #${monitor.id} — incident resolved notification skipped.`
            );
            return;
        }

        const stillAffectedIds = decision.stillAffectedIds || [];
        const affectedMap = await IncidentTracker.getMonitorsByIDs(stillAffectedIds);
        const stillAffectedMonitors = stillAffectedIds.map((id) => affectedMap.get(id)).filter(Boolean);

        const msg = IncidentTracker.formatIncidentUpMessage(monitor.name, stillAffectedMonitors);

        const heartbeatJSON = await Monitor.buildHeartbeatJSON(bean);
        heartbeatJSON.isIncident = true;
        heartbeatJSON.isIncidentResolved = true;
        heartbeatJSON.incidentRootMonitorId = monitor.id;
        heartbeatJSON.incidentStillAffectedIds = stillAffectedIds;

        log.debug(
            "monitor",
            `[Incident] Sending consolidated UP notification for root monitor #${monitor.id} (${monitor.name}); ${stillAffectedIds.length} still affected`
        );

        await Monitor.dispatchNotifications(monitor, fullNotificationList, msg, heartbeatJSON);

        // Clear the down-escalation state so checkDownEscalation's UP branch
        // (called later in the same beat) sees no pending escalation tier and
        // does not double-notify about recovery. The consolidated incident
        // notification above already informed the operator.
        Monitor.clearDownEscalationState(monitor.id);
    }

    /**
     * Reset the in-memory down-escalation state for a monitor without
     * persisting. Used when another code path (incident resolution,
     * dispatchIncidentUp) has already handled the recovery notification.
     * @param {number} monitorID
     * @returns {void}
     */
    static clearDownEscalationState(monitorID) {
        const state = downState.get(monitorID);
        if (!state) {
            return;
        }
        state.downStart = null;
        state.downAlertLevel = 0;
    }

    /**
     * Called from the parent's beat loop on every DOWN→DOWN beat. If a
     * child has folded into this monitor's incident since the last
     * consolidated notification (or the parent had no flagged children at
     * its UP→DOWN transition and only created the incident later when a
     * child folded in), this method dispatches the consolidated DOWN
     * notification on the parent's own channels. Keeps the root-cause
     * monitor as the single trigger for the operator-facing alert.
     * @param {Monitor} monitor The parent (root) monitor
     * @param {import("./heartbeat")} bean Heartbeat that triggered this beat
     * @returns {Promise<void>}
     */
    static async maybeFirePendingIncident(monitor, bean) {
        if (!IncidentTracker.hasPendingIncidentForRoot(monitor.id)) {
            return;
        }
        const decision = await IncidentTracker.handleDown(monitor);
        if (decision.send === "incident-root") {
            await Monitor.dispatchIncidentDown(bean, decision);
        }
    }

    /**
     * If the given monitor is the root of an active incident, append a list
     * of affected services to a notification message. Used by the escalation
     * chain so tier-2 / tier-3 outage messages mention the dependent
     * services too.
     * @param {Monitor} monitor Candidate root monitor
     * @param {string} baseMsg Existing message text
     * @returns {Promise<string>} Original message if no incident, or message + affected list
     */
    static async appendIncidentAffectedToMessage(monitor, baseMsg) {
        if (!IncidentTracker.hasIncident(monitor.id)) {
            return baseMsg;
        }
        const affectedIds = IncidentTracker.getAffectedIds(monitor.id);
        if (affectedIds.length === 0) {
            return baseMsg;
        }
        const affectedMap = await IncidentTracker.getMonitorsByIDs(affectedIds);
        const affectedNames = affectedIds
            .map((id) => affectedMap.get(id)?.name)
            .filter(Boolean);
        if (affectedNames.length === 0) {
            return baseMsg;
        }
        const list = affectedNames.map((n) => `  • ${n}`).join("\n");
        return `${baseMsg}\nAffected services:\n${list}`;
    }

    /**
     * Iterate through a list of notifications and deliver each one.
     * Shared between Monitor.sendNotification and Monitor.sendSlowPingNotification.
     * @param {Monitor} monitor The monitor the notifications are about
     * @param {Array} notificationList Result of Monitor.getNotificationList
     * @param {string} msg Pre-formatted message
     * @param {object} heartbeatJSON Heartbeat context for providers
     * @returns {Promise<void>}
     */
    static async dispatchNotifications(monitor, notificationList, msg, heartbeatJSON) {
        const monitorData = [{ id: monitor.id, active: monitor.active, name: monitor.name }];
        const preloadData = await Monitor.preparePreloadData(monitorData);
        const monitorJSON = monitor.toJSON(preloadData, false);
        for (const notification of notificationList) {
            try {
                await Notification.send(JSON.parse(notification.config), msg, monitorJSON, heartbeatJSON);
            } catch (e) {
                log.error("monitor", "Cannot send notification to " + notification.name);
                log.error("monitor", e);
            }
        }
    }

    /**
     * Track sustained slow-ping periods on a monitor instance and fire
     * notifications through Monitor.sendSlowPingNotification when the
     * threshold is crossed and again when it recovers.
     *
     * State (slowPingStart / slowPingAlertSent) lives on the Monitor
     * instance and is reset on every server restart — acceptable since
     * a long slow period that started before restart will simply begin a
     * new 5-min window after restart.
     * @param {Monitor} monitor The monitor being checked
     * @param {import("./heartbeat")} bean The current beat
     * @returns {Promise<void>}
     */
    static async checkSlowPingAlert(monitor, bean) {
        // Don't alert on paused monitors, during planned maintenance, or
        // when ping wasn't measured.
        if (!monitor.active) {
            return;
        }
        if (bean.status === MAINTENANCE) {
            return;
        }
        if (bean.ping == null || typeof bean.ping !== "number") {
            return;
        }

        const state = getSlowPingState(monitor.id);
        const overThreshold = bean.ping > SLOW_PING_THRESHOLD_MS;

        if (overThreshold) {
            if (state.slowPingStart === null) {
                state.slowPingStart = Date.now();
                await Monitor._persistSlowPingState(monitor, state);
            }
            if (
                !state.slowPingAlertSent &&
                Date.now() - state.slowPingStart >= SLOW_PING_DURATION_MS
            ) {
                await Monitor.sendSlowPingNotification(monitor, bean, false);
                state.slowPingAlertSent = true;
                await Monitor._persistSlowPingState(monitor, state);
            }
        } else {
            // Ping dropped back to normal range. If we previously alerted,
            // send a single recovery notification, then clear state.
            if (state.slowPingAlertSent) {
                await Monitor.sendSlowPingNotification(monitor, bean, true);
            }
            if (state.slowPingStart !== null || state.slowPingAlertSent) {
                state.slowPingStart = null;
                state.slowPingAlertSent = false;
                await Monitor._persistSlowPingState(monitor, state);
            }
        }
    }

    /**
     * Persist the current slow-ping state to the monitor row. Called whenever
     * state.slowPingStart or state.slowPingAlertSent changes, so the in-memory
     * Map survives server restarts.
     * @param {Monitor} monitor The monitor to persist
     * @param {{slowPingStart: ?number, slowPingAlertSent: boolean}} state Current state
     * @returns {Promise<void>}
     */
    static async _persistSlowPingState(monitor, state) {
        try {
            monitor.slowPingStart = state.slowPingStart;
            monitor.slowPingAlertSent = state.slowPingAlertSent;
            await R.store(monitor);
        } catch (e) {
            log.error("monitor", `[${monitor.name}] Could not persist slow-ping state: ${e.message}`);
        }
    }

    /**
     * Persist the current down-escalation state to the monitor row.
     * @param {Monitor} monitor The monitor to persist
     * @param {{downStart: ?number, downAlertLevel: number}} state Current state
     * @returns {Promise<void>}
     */
    static async _persistDownState(monitor, state) {
        try {
            monitor.downStart = state.downStart;
            monitor.downAlertLevel = state.downAlertLevel;
            await R.store(monitor);
        } catch (e) {
            log.error("monitor", `[${monitor.name}] Could not persist down-escalation state: ${e.message}`);
        }
    }

    /**
     * Check and perform down-escalation notifications.
     * This function implements tiered alerts for DOWN states:
     *  - Immediate: developer / legacy notifications (escalationLevel unset or 1)
     *  - After 2 minutes: tech lead notifications (escalationLevel = 2)
     *  - After 5 minutes: admin notifications (escalationLevel = 3)
     *
     * Notifications that do not opt-in to escalation (legacy config without
     * escalationLevel) will continue to receive the immediate alert for
     * backward compatibility.
     *
     * This method is safe to call on every heartbeat; it is idempotent and
     * persists its state to the monitor row so server restarts don't lose
     * escalation context.
     * @param {Monitor} monitor The monitor being checked
     * @param {import("./heartbeat")} bean The current beat
     * @returns {Promise<void>}
     */
    static async checkDownEscalation(monitor, bean) {
        // Don't escalate for paused monitors or when under maintenance
        if (!monitor.active) {
            return;
        }
        if (bean.status === MAINTENANCE) {
            return;
        }

        // If this monitor is folded into an active incident as an affected
        // child, the root cause's escalation chain carries it — skip our own.
        // On UP the IncidentTracker suppresses the per-monitor recovery; on
        // DOWN we still want the root cause's DOWN message to lead.
        if (IncidentTracker.isAffected(monitor.id)) {
            return;
        }

        const state = getDownState(monitor.id);
        const notificationList = await Monitor.getNotificationList(monitor);

        // Helper: filter by escalation level where undefined = legacy (treat as immediate).
        // Includes defensive validation: malformed escalationLevel values
        // (1.5, "foo", NaN, -1) are warned and fall back to legacy/immediate
        // so the user is never silently dropped from all tiers.
        const filterByLevel = (list, level) => {
            return list.filter((n) => {
                try {
                    const cfg = JSON.parse(n.config || "{}");
                    if (cfg.escalationLevel === undefined || cfg.escalationLevel === null) {
                        // Legacy notifications remain equivalent to the immediate tier,
                        // so they are included for the initial alert only and not for
                        // later tech-lead/admin escalations.
                        return level === 1;
                    }
                    const lvl = Number(cfg.escalationLevel);
                    if (!Number.isInteger(lvl) || lvl < 1 || lvl > 3) {
                        log.warn(
                            "monitor",
                            `[${monitor.name}] Notification ${n.name} has invalid ` +
                                `escalationLevel=${JSON.stringify(cfg.escalationLevel)}; ` +
                                `treating as legacy/immediate.`
                        );
                        return level === 1;
                    }
                    return lvl === level;
                } catch (e) {
                    return level === 1;
                }
            });
        };

        const TECH_MS = 2 * 60 * 1000;
        const ADMIN_MS = 5 * 60 * 1000;

        if (bean.status === DOWN) {
            if (state.downStart === null) {
                // First time we saw DOWN – start the window and persist.
                state.downStart = Date.now();
                // Determine if immediate notifications were (or will be) sent for level 1
                const immediateRecipients = filterByLevel(notificationList, 1);
                if (immediateRecipients.length > 0) {
                    state.downAlertLevel = 1;
                } else {
                    state.downAlertLevel = 0;
                }
                await Monitor._persistDownState(monitor, state);
                return;
            }

            const elapsed = Date.now() - state.downStart;

            // Tech lead escalation at 2 minutes
            if (elapsed >= TECH_MS && state.downAlertLevel < 2) {
                const techList = filterByLevel(notificationList, 2);
                if (techList.length > 0) {
                    const heartbeatJSON = await bean.toJSONAsync({ decodeResponse: true });
                    heartbeatJSON.status = DOWN;
                    heartbeatJSON.msg = heartbeatJSON.msg || "N/A";
                    heartbeatJSON.timezone = await UptimeKumaServer.getInstance().getTimezone();
                    heartbeatJSON.timezoneOffset = UptimeKumaServer.getInstance().getTimezoneOffset();
                    heartbeatJSON.localDateTime = dayjs.utc(heartbeatJSON.time).tz(heartbeatJSON.timezone).format(SQL_DATETIME_FORMAT);

                    const msg = `[${monitor.name}] [⚠️ Prolonged outage] Service still down after ${Math.round(elapsed/1000)}s`;
                    const finalMsg = await Monitor.appendIncidentAffectedToMessage(monitor, msg);
                    await Monitor.dispatchNotifications(monitor, techList, finalMsg, heartbeatJSON);
                }
                state.downAlertLevel = 2;
                await Monitor._persistDownState(monitor, state);
            }

            // Admin escalation at 5 minutes
            if (elapsed >= ADMIN_MS && state.downAlertLevel < 3) {
                const adminList = filterByLevel(notificationList, 3);
                if (adminList.length > 0) {
                    const heartbeatJSON = await bean.toJSONAsync({ decodeResponse: true });
                    heartbeatJSON.status = DOWN;
                    heartbeatJSON.msg = heartbeatJSON.msg || "N/A";
                    heartbeatJSON.timezone = await UptimeKumaServer.getInstance().getTimezone();
                    heartbeatJSON.timezoneOffset = UptimeKumaServer.getInstance().getTimezoneOffset();
                    heartbeatJSON.localDateTime = dayjs.utc(heartbeatJSON.time).tz(heartbeatJSON.timezone).format(SQL_DATETIME_FORMAT);

                    const msg = `[${monitor.name}] [🚨 Outage] Service still down after ${Math.round(elapsed/1000)}s`;
                    const finalMsg = await Monitor.appendIncidentAffectedToMessage(monitor, msg);
                    await Monitor.dispatchNotifications(monitor, adminList, finalMsg, heartbeatJSON);
                }
                state.downAlertLevel = 3;
                await Monitor._persistDownState(monitor, state);
            }
        } else if (bean.status === UP) {
            // Recovery: notify only those who were previously alerted (levels <= downAlertLevel)
            if (state.downAlertLevel > 0) {
                const heartbeatJSON = await bean.toJSONAsync({ decodeResponse: true });
                heartbeatJSON.status = UP;
                heartbeatJSON.msg = heartbeatJSON.msg || "N/A";
                heartbeatJSON.timezone = await UptimeKumaServer.getInstance().getTimezone();
                heartbeatJSON.timezoneOffset = UptimeKumaServer.getInstance().getTimezoneOffset();
                heartbeatJSON.localDateTime = dayjs.utc(heartbeatJSON.time).tz(heartbeatJSON.timezone).format(SQL_DATETIME_FORMAT);

                const recipients = notificationList.filter((n) => {
                    try {
                        const cfg = JSON.parse(n.config || "{}");
                        if (cfg.escalationLevel === undefined || cfg.escalationLevel === null) {
                            return true;
                        }
                        const lvl = Number(cfg.escalationLevel);
                        if (!Number.isInteger(lvl) || lvl < 1 || lvl > 3) {
                            return true;
                        }
                        return lvl <= state.downAlertLevel;
                    } catch (e) {
                        return true;
                    }
                });

                // Mark that the recovery branch fired so sendStandardNotification's
                // UP path can skip the duplicate plain "✅ Up" message.
                state.recoveryFired = true;

                const msg = `[${monitor.name}] [✅ Recovered] Service recovered after ${state.downStart ? Math.round((Date.now() - state.downStart)/1000) : "N/A"}s`;
                await Monitor.dispatchNotifications(monitor, recipients, msg, heartbeatJSON);
            }

            // Clear state — also reset the recoveryFired coordination flag so
            // the next UP beat (if any) doesn't accidentally skip its standard
            // notification.
            if (state.downStart !== null || state.downAlertLevel !== 0 || state.recoveryFired) {
                const st = getDownState(monitor.id);
                st.downStart = null;
                st.downAlertLevel = 0;
                st.recoveryFired = false;
                await Monitor._persistDownState(monitor, st);
            }
        }
    }

    /**
     * Send a slow-ping (or slow-ping-recovery) notification to every
     * notification provider configured for this monitor. Mirrors the shape
     * of Monitor.sendNotification so the existing provider ecosystem can
     * handle it.
     *
     * Trade-off note: heartbeatJSON.status is intentionally set to DOWN for
     * the slow alert (UP for the recovery) so that providers branching on
     * status === UP/DOWN (Discord, Slack, Telegram, etc. — 51 of them)
     * still send something instead of nothing. The downside is that default Discord/Slack
     * embeds render the "went down" template even though the service is
     * still UP and just slow. The msg + isSlowPing/isSlowPingRecovery
     * fields make the actual story unambiguous. A future improvement
     * could introduce a SLOW_PING status (4) and update a few providers
     * to special-case it; that's out of scope here.
     * @param {Monitor} monitor The monitor the alert is about
     * @param {import("./heartbeat")} bean The beat that triggered the alert
     * @param {boolean} isRecovered True if this is a recovery notification
     * @returns {Promise<void>}
     */
    static async sendSlowPingNotification(monitor, bean, isRecovered) {
        const notificationList = await Monitor.getNotificationList(monitor);

        if (notificationList.length === 0) {
            log.debug(
                "monitor",
                `[${monitor.name}] Slow-ping notification skipped: no notifications configured for this monitor.`
            );
            return;
        }

        const header = isRecovered ? "✅ Slow Response Resolved" : "⚠️ Slow Response — not down, just slow";
        const detail = isRecovered
            ? `Response time is back at or below ${SLOW_PING_THRESHOLD_MS} ms (current: ${bean.ping} ms)`
            : `Response time has exceeded ${SLOW_PING_THRESHOLD_MS} ms continuously for over 5 minutes (current: ${bean.ping} ms)`;

        const msg = `[${monitor.name}] [${header}] ${detail}`;

        // Build a heartbeatJSON-shaped object so providers receive the same
        // shape they already understand. status is set to DOWN/UP so
        // providers that branch on status still send something, and the
        // msg field carries the actual story.
        const heartbeatJSON = await bean.toJSONAsync({ decodeResponse: true });
        heartbeatJSON.status = isRecovered ? UP : DOWN;
        heartbeatJSON.msg = detail;
        heartbeatJSON.isSlowPing = !isRecovered;
        heartbeatJSON.isSlowPingRecovery = isRecovered;
        if (!heartbeatJSON.msg) {
            heartbeatJSON.msg = "N/A";
        }

        heartbeatJSON.timezone = await UptimeKumaServer.getInstance().getTimezone();
        heartbeatJSON.timezoneOffset = UptimeKumaServer.getInstance().getTimezoneOffset();
        heartbeatJSON.localDateTime = dayjs
            .utc(heartbeatJSON.time)
            .tz(heartbeatJSON.timezone)
            .format(SQL_DATETIME_FORMAT);

        log.debug("monitor", `[${monitor.name}] sendSlowPingNotification (recovered=${isRecovered})`);

        await Monitor.dispatchNotifications(monitor, notificationList, msg, heartbeatJSON);
    }

    /**
     * Get list of notification providers for a given monitor
     * @param {Monitor} monitor Monitor to get notification providers for
     * @returns {Promise<LooseObject<any>[]>} List of notifications
     */
    static async getNotificationList(monitor) {
        let notificationList = await R.getAll(
            "SELECT notification.* FROM notification, monitor_notification WHERE monitor_id = ? AND monitor_notification.notification_id = notification.id ",
            [monitor.id]
        );
        return notificationList;
    }

    /**
     * Send a certificate notification when certificate expires in less
     * than target days
     * @param {string} certCN  Common Name attribute from the certificate subject
     * @param {string} certType  certificate type
     * @param {number} daysRemaining Number of days remaining on certificate
     * @param {number} targetDays Number of days to alert after
     * @param {LooseObject<any>[]} notificationList List of notification providers
     * @returns {Promise<void>}
     */
    async sendCertNotificationByTargetDays(certCN, certType, daysRemaining, targetDays, notificationList) {
        let row = await R.getRow(
            "SELECT * FROM notification_sent_history WHERE type = ? AND monitor_id = ? AND days <= ?",
            ["certificate", this.id, targetDays]
        );

        // Sent already, no need to send again
        if (row) {
            log.debug("monitor", "Sent already, no need to send again");
            return;
        }

        let sent = false;
        log.debug("monitor", "Send certificate notification");

        for (let notification of notificationList) {
            try {
                log.debug("monitor", "Sending to " + notification.name);
                await Notification.send(
                    JSON.parse(notification.config),
                    `[${this.name}][${this.url}] ${certType} certificate ${certCN} will expire in ${daysRemaining} days`
                );
                sent = true;
            } catch (e) {
                log.error("monitor", "Cannot send cert notification to " + notification.name);
                log.error("monitor", e);
            }
        }

        if (sent) {
            await R.exec("INSERT INTO notification_sent_history (type, monitor_id, days) VALUES(?, ?, ?)", [
                "certificate",
                this.id,
                targetDays,
            ]);
        }
    }

    /**
     * Get the status of the previous heartbeat
     * @param {number} monitorID ID of monitor to check
     * @returns {Promise<LooseObject<any>>} Previous heartbeat
     */
    static async getPreviousHeartbeat(monitorID) {
        return await R.findOne("heartbeat", " id = (select MAX(id) from heartbeat where monitor_id = ?)", [monitorID]);
    }

    /**
     * Check if monitor is under maintenance
     * @param {number} monitorID ID of monitor to check
     * @returns {Promise<boolean>} Is the monitor under maintenance
     */
    static async isUnderMaintenance(monitorID) {
        const maintenanceIDList = await R.getCol(
            `
            SELECT maintenance_id FROM monitor_maintenance
            WHERE monitor_id = ?
        `,
            [monitorID]
        );

        for (const maintenanceID of maintenanceIDList) {
            const maintenance = await UptimeKumaServer.getInstance().getMaintenance(maintenanceID);
            if (maintenance && (await maintenance.isUnderMaintenance())) {
                return true;
            }
        }

        const parent = await Monitor.getParent(monitorID);
        if (parent != null) {
            return await Monitor.isUnderMaintenance(parent.id);
        }

        return false;
    }

    /**
     * Validate monitor configuration
     * @returns {void}
     * @throws {Error} If validation fails
     */
    validate() {
        if (this.interval < MIN_INTERVAL_SECOND) {
            throw new Error(`Interval cannot be less than ${MIN_INTERVAL_SECOND} seconds`);
        }

        if (this.retryInterval < MIN_INTERVAL_SECOND) {
            throw new Error(`Retry interval cannot be less than ${MIN_INTERVAL_SECOND} seconds`);
        }

        if (this.response_max_length !== undefined) {
            if (this.response_max_length < 0) {
                throw new Error(`Response max length cannot be less than 0`);
            }

            if (this.response_max_length > RESPONSE_BODY_LENGTH_MAX) {
                throw new Error(`Response max length cannot be more than ${RESPONSE_BODY_LENGTH_MAX} bytes`);
            }
        }

        // Validate JSON fields to prevent invalid JSON from being stored in database
        if (this.kafkaProducerBrokers) {
            try {
                JSON.parse(this.kafkaProducerBrokers);
            } catch (e) {
                throw new Error(`Kafka Producer Brokers must be valid JSON: ${e.message}`);
            }
        }

        if (this.kafkaProducerSaslOptions) {
            try {
                JSON.parse(this.kafkaProducerSaslOptions);
            } catch (e) {
                throw new Error(`Kafka Producer SASL Options must be valid JSON: ${e.message}`);
            }
        }

        if (this.rabbitmqNodes) {
            try {
                JSON.parse(this.rabbitmqNodes);
            } catch (e) {
                throw new Error(`RabbitMQ Nodes must be valid JSON: ${e.message}`);
            }
        }

        if (this.conditions) {
            try {
                JSON.parse(this.conditions);
            } catch (e) {
                throw new Error(`Conditions must be valid JSON: ${e.message}`);
            }
        }

        if (this.headers) {
            try {
                JSON.parse(this.headers);
            } catch (e) {
                throw new Error(`Headers must be valid JSON: ${e.message}`);
            }
        }

        if (this.accepted_statuscodes_json) {
            try {
                JSON.parse(this.accepted_statuscodes_json);
            } catch (e) {
                throw new Error(`Accepted status codes must be valid JSON: ${e.message}`);
            }
        }

        if (["system-service", "pm2"].includes(this.type)) {
            this.system_service_name = (this.system_service_name || "").trim();

            if (!this.system_service_name) {
                throw new Error(this.type === "pm2" ? "PM2 process name is required." : "Service Name is required.");
            }
        }

        if (this.type === "system-service" && !/^[a-zA-Z0-9._\-@]+$/.test(this.system_service_name)) {
            throw new Error("Invalid service name. Please use the internal Service Name (no spaces).");
        }

        if (this.type === "pm2" && /[\u0000-\u001F\u007F]/.test(this.system_service_name)) {
            throw new Error("Invalid PM2 process name.");
        }

        if (this.type === "ping") {
            // ping parameters validation
            if (this.packetSize && (this.packetSize < PING_PACKET_SIZE_MIN || this.packetSize > PING_PACKET_SIZE_MAX)) {
                throw new Error(
                    `Packet size must be between ${PING_PACKET_SIZE_MIN} and ${PING_PACKET_SIZE_MAX} (default: ${PING_PACKET_SIZE_DEFAULT})`
                );
            }

            if (
                this.ping_per_request_timeout &&
                (this.ping_per_request_timeout < PING_PER_REQUEST_TIMEOUT_MIN ||
                    this.ping_per_request_timeout > PING_PER_REQUEST_TIMEOUT_MAX)
            ) {
                throw new Error(
                    `Per-ping timeout must be between ${PING_PER_REQUEST_TIMEOUT_MIN} and ${PING_PER_REQUEST_TIMEOUT_MAX} seconds (default: ${PING_PER_REQUEST_TIMEOUT_DEFAULT})`
                );
            }

            if (this.ping_count && (this.ping_count < PING_COUNT_MIN || this.ping_count > PING_COUNT_MAX)) {
                throw new Error(
                    `Echo requests count must be between ${PING_COUNT_MIN} and ${PING_COUNT_MAX} (default: ${PING_COUNT_DEFAULT})`
                );
            }

            if (this.timeout) {
                const pingGlobalTimeout = Math.round(Number(this.timeout));

                if (
                    pingGlobalTimeout < this.ping_per_request_timeout ||
                    pingGlobalTimeout < PING_GLOBAL_TIMEOUT_MIN ||
                    pingGlobalTimeout > PING_GLOBAL_TIMEOUT_MAX
                ) {
                    throw new Error(
                        `Timeout must be between ${PING_GLOBAL_TIMEOUT_MIN} and ${PING_GLOBAL_TIMEOUT_MAX} seconds (default: ${PING_GLOBAL_TIMEOUT_DEFAULT})`
                    );
                }

                this.timeout = pingGlobalTimeout;
            }
        }

        if (this.type === "real-browser") {
            // screenshot_delay validation
            if (this.screenshot_delay !== undefined && this.screenshot_delay !== null) {
                const delay = Number(this.screenshot_delay);
                if (isNaN(delay) || delay < 0) {
                    throw new Error("Screenshot delay must be a non-negative number");
                }

                // Must not exceed 0.8 * timeout (page.goto timeout is interval * 1000 * 0.8)
                const maxDelayFromTimeout = this.interval * 1000 * 0.8;
                if (delay >= maxDelayFromTimeout) {
                    throw new Error(`Screenshot delay must be less than ${maxDelayFromTimeout}ms (0.8 × interval)`);
                }

                // Must not exceed 0.5 * interval to prevent blocking next check
                const maxDelayFromInterval = this.interval * 1000 * 0.5;
                if (delay >= maxDelayFromInterval) {
                    throw new Error(`Screenshot delay must be less than ${maxDelayFromInterval}ms (0.5 × interval)`);
                }
            }
        }

        if (this.type === "mongodb" && this.databaseQuery) {
            // Validate that databaseQuery is valid JSON
            try {
                JSON.parse(this.databaseQuery);
            } catch (error) {
                throw new Error(`Invalid JSON in database query: ${error.message}`);
            }
        }
    }

    /**
     * Gets monitor notification of multiple monitor
     * @param {Array} monitorIDs IDs of monitor to get
     * @returns {Promise<LooseObject<any>>} object
     */
    static async getMonitorNotification(monitorIDs) {
        return await R.getAll(
            `
            SELECT monitor_notification.monitor_id, monitor_notification.notification_id
            FROM monitor_notification
            WHERE monitor_notification.monitor_id IN (${monitorIDs.map((_) => "?").join(",")})
        `,
            monitorIDs
        );
    }

    /**
     * Gets monitor tags of multiple monitor
     * @param {Array} monitorIDs IDs of monitor to get
     * @returns {Promise<LooseObject<any>>} object
     */
    static async getMonitorTag(monitorIDs) {
        return await R.getAll(
            `
            SELECT monitor_tag.monitor_id, monitor_tag.tag_id, monitor_tag.value, tag.name, tag.color
            FROM monitor_tag
            JOIN tag ON monitor_tag.tag_id = tag.id
            WHERE monitor_tag.monitor_id IN (${monitorIDs.map((_) => "?").join(",")})
        `,
            monitorIDs
        );
    }

    /**
     * prepare preloaded data for efficient access
     * @param {Array} monitorData IDs & active field of monitor to get
     * @returns {Promise<LooseObject<any>>} object
     */
    static async preparePreloadData(monitorData) {
        const notificationsMap = new Map();
        const tagsMap = new Map();
        const maintenanceStatusMap = new Map();
        const childrenIDsMap = new Map();
        const activeStatusMap = new Map();
        const forceInactiveMap = new Map();
        const pathsMap = new Map();

        if (monitorData.length > 0) {
            const monitorIDs = monitorData.map((monitor) => monitor.id);
            const notifications = await Monitor.getMonitorNotification(monitorIDs);
            const tags = await Monitor.getMonitorTag(monitorIDs);
            const maintenanceStatuses = await Promise.all(
                monitorData.map((monitor) => Monitor.isUnderMaintenance(monitor.id))
            );
            const childrenIDs = await Promise.all(monitorData.map((monitor) => Monitor.getAllChildrenIDs(monitor.id)));
            const activeStatuses = await Promise.all(
                monitorData.map((monitor) => Monitor.isActive(monitor.id, monitor.active))
            );
            const forceInactiveStatuses = await Promise.all(
                monitorData.map((monitor) => Monitor.isParentActive(monitor.id))
            );
            const paths = await Promise.all(monitorData.map((monitor) => Monitor.getAllPath(monitor.id, monitor.name)));

            notifications.forEach((row) => {
                if (!notificationsMap.has(row.monitor_id)) {
                    notificationsMap.set(row.monitor_id, {});
                }
                notificationsMap.get(row.monitor_id)[row.notification_id] = true;
            });

            tags.forEach((row) => {
                if (!tagsMap.has(row.monitor_id)) {
                    tagsMap.set(row.monitor_id, []);
                }
                tagsMap.get(row.monitor_id).push({
                    tag_id: row.tag_id,
                    monitor_id: row.monitor_id,
                    value: row.value,
                    name: row.name,
                    color: row.color,
                });
            });

            monitorData.forEach((monitor, index) => {
                maintenanceStatusMap.set(monitor.id, maintenanceStatuses[index]);
            });

            monitorData.forEach((monitor, index) => {
                childrenIDsMap.set(monitor.id, childrenIDs[index]);
            });

            monitorData.forEach((monitor, index) => {
                activeStatusMap.set(monitor.id, activeStatuses[index]);
            });

            monitorData.forEach((monitor, index) => {
                forceInactiveMap.set(monitor.id, !forceInactiveStatuses[index]);
            });

            monitorData.forEach((monitor, index) => {
                pathsMap.set(monitor.id, paths[index]);
            });
        }

        return {
            notifications: notificationsMap,
            tags: tagsMap,
            maintenanceStatus: maintenanceStatusMap,
            childrenIDs: childrenIDsMap,
            activeStatus: activeStatusMap,
            forceInactive: forceInactiveMap,
            paths: pathsMap,
        };
    }

    /**
     * Gets Parent of the monitor
     * @param {number} monitorID ID of monitor to get
     * @returns {Promise<LooseObject<any>>} Parent
     */
    static async getParent(monitorID) {
        return await R.getRow(
            `
            SELECT parent.* FROM monitor parent
    		LEFT JOIN monitor child
    			ON child.parent = parent.id
            WHERE child.id = ?
        `,
            [monitorID]
        );
    }

    /**
     * Gets all Children of the monitor
     * @param {number} monitorID ID of monitor to get
     * @returns {Promise<LooseObject<any>[]>} Children
     */
    static async getChildren(monitorID) {
        return await R.getAll(
            `
            SELECT * FROM monitor
            WHERE parent = ?
        `,
            [monitorID]
        );
    }

    /**
     * Gets the full path
     * @param {number} monitorID ID of the monitor to get
     * @param {string} name of the monitor to get
     * @returns {Promise<string[]>} Full path (includes groups and the name) of the monitor
     */
    static async getAllPath(monitorID, name) {
        const path = [name];

        if (this.parent === null) {
            return path;
        }

        let parent = await Monitor.getParent(monitorID);
        while (parent !== null) {
            path.unshift(parent.name);
            parent = await Monitor.getParent(parent.id);
        }

        return path;
    }

    /**
     * Gets recursive all child ids
     * @param {number} monitorID ID of the monitor to get
     * @returns {Promise<Array>} IDs of all children
     */
    static async getAllChildrenIDs(monitorID) {
        const childs = await Monitor.getChildren(monitorID);

        if (childs === null) {
            return [];
        }

        let childrenIDs = [];

        for (const child of childs) {
            childrenIDs.push(child.id);
            childrenIDs = childrenIDs.concat(await Monitor.getAllChildrenIDs(child.id));
        }

        return childrenIDs;
    }

    /**
     * Unlinks all children of the group monitor
     * @param {number} groupID ID of group to remove children of
     * @returns {Promise<void>}
     */
    static async unlinkAllChildren(groupID) {
        return await R.exec("UPDATE `monitor` SET parent = ? WHERE parent = ? ", [null, groupID]);
    }

    /**
     * Delete a monitor from the system
     * @param {number} monitorID ID of the monitor to delete
     * @param {number} userID ID of the user who owns the monitor
     * @returns {Promise<void>}
     */
    static async deleteMonitor(monitorID, userID) {
        const server = UptimeKumaServer.getInstance();

        // Stop the monitor if it's running
        if (monitorID in server.monitorList) {
            await server.monitorList[monitorID].stop();
            delete server.monitorList[monitorID];
        }

        // Delete from database
        await R.exec("DELETE FROM monitor WHERE id = ? AND user_id = ? ", [monitorID, userID]);
    }

    /**
     * Recursively delete a monitor and all its descendants
     * @param {number} monitorID ID of the monitor to delete
     * @param {number} userID ID of the user who owns the monitor
     * @returns {Promise<void>}
     */
    static async deleteMonitorRecursively(monitorID, userID) {
        // Check if this monitor is a group
        const monitor = await R.findOne("monitor", " id = ? AND user_id = ? ", [monitorID, userID]);

        if (monitor && monitor.type === "group") {
            // Get all children and delete them recursively
            const children = await Monitor.getChildren(monitorID);
            if (children && children.length > 0) {
                for (const child of children) {
                    await Monitor.deleteMonitorRecursively(child.id, userID);
                }
            }
        }

        // Delete the monitor itself
        await Monitor.deleteMonitor(monitorID, userID);
    }

    /**
     * Checks recursive if parent (ancestors) are active
     * @param {number} monitorID ID of the monitor to get
     * @returns {Promise<boolean>} Is the parent monitor active?
     */
    static async isParentActive(monitorID) {
        const parent = await Monitor.getParent(monitorID);

        if (parent === null) {
            return true;
        }

        const parentActive = await Monitor.isParentActive(parent.id);
        return parent.active === 1 && parentActive;
    }

    /**
     * Obtains a new Oidc Token
     * @returns {Promise<object>} OAuthProvider client
     */
    async makeOidcTokenClientCredentialsRequest() {
        log.debug("monitor", `[${this.name}] The oauth access-token undefined or expired. Requesting a new token`);
        const oAuthAccessToken = await getOidcTokenClientCredentials(
            this.oauth_token_url,
            this.oauth_client_id,
            this.oauth_client_secret,
            this.oauth_scopes,
            this.oauth_audience,
            this.oauth_auth_method
        );
        if (this.oauthAccessToken?.expires_at) {
            log.debug(
                "monitor",
                `[${this.name}] Obtained oauth access-token. Expires at ${new Date(this.oauthAccessToken?.expires_at * 1000)}`
            );
        } else {
            log.debug("monitor", `[${this.name}] Obtained oauth access-token. Time until expiry was not provided`);
        }

        return oAuthAccessToken;
    }

    /**
     * Store TLS certificate information and check for expiry
     * @param {object} tlsInfo Information about the TLS connection
     * @returns {Promise<void>}
     */
    async handleTlsInfo(tlsInfo) {
        await this.updateTlsInfo(tlsInfo);
        this.prometheus?.update(null, tlsInfo, null);

        if (!this.getIgnoreTls() && this.isEnabledExpiryNotification()) {
            log.debug("monitor", `[${this.name}] call checkCertExpiryNotifications`);
            await checkCertExpiryNotifications(this, tlsInfo);
        }
    }
}

module.exports = Monitor;
