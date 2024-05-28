
import { 
    Player, Topic, PlayerState, SubscribePayload, AdvertiseOptions, PublishPayload, 
    TopicStats, PlayerPresence, PlayerMetricsCollectorInterface, PlayerCapabilities
} from "../types/types";
import { ParameterValue } from "../types/studio";
import { RosDatatypes } from "../types/RosDatatypes";
import { FoxgloveClient, Channel, ChannelId, SubscriptionId, Parameter } from "@foxglove/ws-protocol";
import { v4 as uuidv4 } from "uuid";
import debouncePromise from "../async/debouncePromise";
import * as base64 from "@protobufjs/base64";
import { parseChannel, ParsedChannel } from "../protobufParser";
import { isEqual } from "lodash";
import { fromMillis, isGreaterThan, isLessThan, Time } from "@foxglove/rostime";

type ResolvedChannel = { channel: Channel; parsedChannel: ParsedChannel };
const SUBSCRIPTION_WARNING_SUPPRESSION_MS = 2000;
const ZERO_TIME = Object.freeze({ sec: 0, nsec: 0 });

export default class FoxgloveWebSocketPlayer implements Player {
    private _url: string;
    private _name: string;
    /** Earliest time seen */
    private _startTime?: Time;
    /** Latest time seen */
    private _endTime?: Time;
    private _client?: FoxgloveClient;
    private _id: string = uuidv4();
    private _topics?: Topic[];
    private _listener?: (arg0: PlayerState) => Promise<void>;
    private _channelsByTopic = new Map<string, ResolvedChannel>();
    private _channelsById = new Map<ChannelId, ResolvedChannel>();
    private _closed: boolean = false;
    private _connectionAttemptTimeout?: ReturnType<typeof setInterval>;
    private _unsupportedChannelIds = new Set<ChannelId>();
    private _resolvedSubscriptionsByTopic = new Map<string, SubscriptionId>();
    private _resolvedSubscriptionsById = new Map<SubscriptionId, ResolvedChannel>();
    private _unresolvedSubscriptions = new Set<string>();
    private _topicsStats = new Map<string, TopicStats>();
    private _datatypes: RosDatatypes = new Map();
    private _presence: PlayerPresence = PlayerPresence.INITIALIZING;
    private _hasReceivedMessage = false;
    private _metricsCollector: PlayerMetricsCollectorInterface;
    private _recentlyCanceledSubscriptions = new Set<SubscriptionId>();
    private _receivedBytes: number = 0;
    private _parsedMessages: MessageEvent<unknown>[] = [];
    private _serverPublishesTime = false;
    private _clockTime?: Time;
    private _profile?: string;
    private _playerCapabilities: (typeof PlayerCapabilities)[keyof typeof PlayerCapabilities][] = [];
    private _urlState: PlayerState["urlState"];
    private _parameters = new Map<string, ParameterValue>();
    private _publishedTopics?: Map<string, Set<string>>;
    private _subscribedTopics?: Map<string, Set<string>>;
    private _advertisedServices?: Map<string, Set<string>>;

    public constructor({ url, metricsCollector, sourceId,  rosNumber}: { url: string, metricsCollector:PlayerMetricsCollectorInterface, sourceId: string, rosNumber: string }){
        this._url = url;
        this._name = url;
        this._metricsCollector = metricsCollector;
        this._metricsCollector.playerConstructed();
        this._urlState = {
            sourceId: sourceId,
            parameters: { url: this._url },
        };
        this._open();
    };

    private _open = (): void => {
        if (this._closed) return;
        if (this._client != undefined) {
            throw new Error(`Attempted to open a second Foxglove WebSocket connection`);
        };

        this._connectionAttemptTimeout = setTimeout(() => {
            this._client?.close();
        }, 10000);

        const ws2:WebSocket = new WebSocket(this._url, [FoxgloveClient.SUPPORTED_SUBPROTOCOL]);
        this._client = new FoxgloveClient({
            ws: ws2
        });

        this._client.on("open", () => {
            console.log("open::::");
            if (this._closed) return;

            if (this._connectionAttemptTimeout != undefined) {
                clearTimeout(this._connectionAttemptTimeout);
            };

            this._presence = PlayerPresence.PRESENT;
            this._channelsByTopic.clear();
            this._resolvedSubscriptionsById.clear();
            this._publishedTopics = undefined;
            this._subscribedTopics = undefined;
            this._advertisedServices = undefined;
        });

        this._client.on("error", (error) => {
            console.log("error:::", error)
        });

        this._client.on("close", () => {
            console.log("close:::");
            this._presence = PlayerPresence.RECONNECTING;
        });

        this._client.on("serverInfo", (event) => {
            console.log("serverInfo::::", event);
            this._emitState();
        });

        this._client.on("status", (event) => {
            console.log("status::::", event)
        });

        this._client.on("message", (info: any) => {
            console.log("message:::", info);
            const {subscriptionId,data} = info;
            
            if(subscriptionId == undefined){
                let {subscriptionId,message} = data;
                console.log('浏览器关闭连接!....,message=',message);

                if(subscriptionId <= -10000){
                    this._resetSessionState();
                    this._presence=PlayerPresence.NOT_PRESENT;
                    this._emitState(); 
                    this.close();
                };  
                return;
            };

            if (!this._hasReceivedMessage) {
                this._hasReceivedMessage = true;
                this._metricsCollector.recordTimeToFirstMsgs();
            };

            const chanInfo = this._resolvedSubscriptionsById.get(subscriptionId);
            if (!chanInfo) {
                const wasRecentlyCanceled = this._recentlyCanceledSubscriptions.has(subscriptionId);
                if (!wasRecentlyCanceled) {this._emitState();}
                return;
            };
            try {
                this._receivedBytes += data.byteLength;
                const receiveTime = this._getCurrentTime();
                const topic = chanInfo.channel.topic;
                this._parsedMessages.push({
                  topic,
                  receiveTime,
                  message: chanInfo.parsedChannel.deserialize(data),
                  sizeInBytes: data.byteLength,
                  schemaName: chanInfo.channel.schemaName,
                } as any);
        
                // Update the message count for this topic
                let stats = this._topicsStats.get(topic);
                if (!stats) {
                  stats = { numMessages: 0 };
                  this._topicsStats.set(topic, stats);
                }
                stats.numMessages++;
            } catch (error) {}
            this._emitState();
        });

        this._client.on("advertise", (newChannels) => {
            console.log("advertise:::", newChannels);
            let parsedChannel: any;
            newChannels.forEach((channel, index) => {
                try{
                    const schemaEncoding = channel.encoding;
                    const schemaData = new Uint8Array(base64.length(channel.schema));
                    if (base64.decode(channel.schema, schemaData, 0) !== schemaData.byteLength) {
                        throw new Error(`Failed to decode base64 schema on channel ${channel.id}`);
                    };

                    parsedChannel = parseChannel({
                        messageEncoding: channel.encoding,
                        schema: { name: channel.schemaName, encoding: schemaEncoding, data: schemaData },
                    });
                    
                }catch(error) {
                    this._unsupportedChannelIds.add(channel.id);
                    this._emitState();
                };

                const existingChannel = this._channelsByTopic.get(channel.topic);
                if (existingChannel && !isEqual(channel, existingChannel.channel)) {
                    this._emitState();
                };
                const resolvedChannel = { channel, parsedChannel };
                this._channelsById.set(channel.id, resolvedChannel as any);
                this._channelsByTopic.set(channel.topic, resolvedChannel as any);
                
            });
            this._updateTopicsAndDatatypes();
            this._emitState();
            this._processUnresolvedSubscriptions();
        });

        this._client.on("unadvertise", (removedChannels) => {
            console.log("unadvertise:::", removedChannels);
            for (const id of removedChannels) {
                const chanInfo = this._channelsById.get(id);
                if (!chanInfo) {
                    if (!this._unsupportedChannelIds.delete(id)) {
                        this._emitState();
                    }
                    continue;
                }
                
                for (const [subId, { channel }] of this._resolvedSubscriptionsById as any) {
                    if (channel.id === id) {
                        this._resolvedSubscriptionsById.delete(subId);
                        this._resolvedSubscriptionsByTopic.delete(channel.topic);
                        this._client?.unsubscribe(subId);
                        this._unresolvedSubscriptions.add(channel.topic);
                    }
                }
                this._channelsById.delete(id);
                this._channelsByTopic.delete(chanInfo.channel.topic);
            }
            this._updateTopicsAndDatatypes();
            this._emitState();
        });

        this._client.on("time", (info) => {
            console.log("time::::", info)
        })

        this._client.on("parameterValues", (info) => {
            console.log("parameterValues", info)
        })
        
        this._client.on("advertiseServices", (services) => {
            console.log("advertiseServices:::", services)
        });

        this._client.on("unadvertiseServices", (serviceIds) => {
            console.log("unadvertiseServices:::", serviceIds)
        });

        this._client.on("serviceCallResponse", (response) => {
            console.log("serviceCallResponse:::", response)
        });

        this._client.on("connectionGraphUpdate", (event) => {
            console.log("connectionGraphUpdate:::", event)
        })
    };

    publish({ topic, msg }: PublishPayload): void {

    };

    public setSubscriptions(subscriptions: SubscribePayload[]): void {
        const newTopics = new Set(subscriptions.map(({ topic }) => topic));

        if (!this._client || this._closed) {
            this._unresolvedSubscriptions = newTopics;
            return;
        }

        for (const topic of newTopics as any) {
            if (!this._resolvedSubscriptionsByTopic.has(topic)) {
                this._unresolvedSubscriptions.add(topic);
            }
        }

        for (const [topic, subId] of this._resolvedSubscriptionsByTopic as any) {
            if (!newTopics.has(topic)) {
                this._client.unsubscribe(subId);
                this._resolvedSubscriptionsByTopic.delete(topic);
                this._resolvedSubscriptionsById.delete(subId);
                this._recentlyCanceledSubscriptions.add(subId);

                // Reset the message count for this topic
                this._topicsStats.delete(topic);

                setTimeout(() => this._recentlyCanceledSubscriptions.delete(subId),
                    SUBSCRIPTION_WARNING_SUPPRESSION_MS,
                );
            }
        }
        for (const topic of this._unresolvedSubscriptions as any) {
            if (!newTopics.has(topic)) {
                this._unresolvedSubscriptions.delete(topic);
            }
        }

        this._processUnresolvedSubscriptions();
    };

    public setPublishers(publishers: AdvertiseOptions[]): void {

    };

    private _getCurrentTime(): Time {
        if (!this._serverPublishesTime) {
          this._clockTime = this._presence === PlayerPresence.PRESENT ? fromMillis(Date.now()) : this._clockTime;
        }
    
        return this._clockTime ?? ZERO_TIME;
    }

    private _updateTopicsAndDatatypes() {
        // Build a new topics array from this._channelsById
        const topics: Topic[] = Array.from(this._channelsById.values(), (chanInfo) => ({
          name: chanInfo.channel.topic,
          schemaName: chanInfo.channel.schemaName,
        }));
    
        // Remove stats entries for removed topics
        const topicsSet = new Set<string>(topics.map((topic) => topic.name));
        for (const topic of this._topicsStats.keys() as any) {
          if (!topicsSet.has(topic)) {
            this._topicsStats.delete(topic);
          }
        }
    
        this._topics = topics;
    
        // Update the _datatypes map;
        for (const { parsedChannel } of this._channelsById.values() as any) {
          for (const [name, types] of parsedChannel.datatypes) {
            this._datatypes.set(name, types);
          }
        }
        this._datatypes = new Map(this._datatypes); // Signal that datatypes changed.
        this._emitState();
    };

    private _processUnresolvedSubscriptions() {
        if (!this._client) return;
    
        for (const topic of this._unresolvedSubscriptions as any) {
          const chanInfo = this._channelsByTopic.get(topic);
          if (chanInfo) {
            const subId = this._client.subscribe(chanInfo.channel.id);
            this._unresolvedSubscriptions.delete(topic);
            this._resolvedSubscriptionsByTopic.set(topic, subId);
            this._resolvedSubscriptionsById.set(subId, chanInfo);
          }
        }
    };

    public setListener(listener: (arg0: PlayerState) => Promise<void>): void {
        this._listener = listener;
        this._emitState();
    };

    private _emitState = debouncePromise(() => {
        if (!this._listener || this._closed) {
            return Promise.resolve();
        };

        if (!this._topics) {
            return this._listener({
                name: this._name,
                presence: this._presence,
                progress: {},
                capabilities: this._playerCapabilities,
                profile: undefined,
                playerId: this._id,
                activeData: undefined,
                problems: undefined,
                urlState: this._urlState,
            });
        }
          
        const currentTime = this._getCurrentTime();
        if (!this._startTime || isLessThan(currentTime, this._startTime)) {
            this._startTime = currentTime;
        }
        if (!this._endTime || isGreaterThan(currentTime, this._endTime)) {
            this._endTime = currentTime;
        }
      
        const messages:any = this._parsedMessages;
        this._parsedMessages = [];
        return this._listener({
            name: this._name,
            presence: this._presence,
            progress: {},
            capabilities: this._playerCapabilities,
            profile: this._profile,
            playerId: this._id,
            problems: undefined,
            urlState: this._urlState,
      
            activeData: {
                messages,
                totalBytesReceived: this._receivedBytes,
                startTime: this._startTime,
                endTime: this._endTime,
                currentTime,
                isPlaying: true,
                speed: 1,
                lastSeekTime: 0,
                topics: this._topics,
                // Always copy topic stats since message counts and timestamps are being updated
                topicStats: new Map(this._topicsStats),
                datatypes: this._datatypes,
                parameters: new Map(this._parameters),
                publishedTopics: this._publishedTopics,
                subscribedTopics: this._subscribedTopics,
                services: this._advertisedServices,
            },
        });
    });

    public setParameter(key: string, value: ParameterValue): void {
        if (!this._client) {
            throw new Error(`Attempted to set parameters without a valid Foxglove WebSocket connection`);
        };

        this._client.setParameters([{ name: key, value: value as Parameter["value"] }], uuidv4());
      
        
        this._parameters.set(key, value);
        this._emitState();
    };

    public close(): void {
        this._resetSessionState();
        this._presence=PlayerPresence.NOT_PRESENT;
        this._emitState();
        this._closed = true;
        this._client?.close();
        this._metricsCollector.close();
        this._hasReceivedMessage = false;
    };

    public async callService(serviceName: string, request: unknown): Promise<unknown> {
        return new Promise(() => {

        })
    };

    private _resetSessionState(): void {
        this._startTime = undefined;
        this._endTime = undefined;
        this._clockTime = undefined;
        this._topicsStats = new Map();
        this._parsedMessages = [];
        this._receivedBytes = 0;
        this._hasReceivedMessage = false;
        this._parameters.clear();
    }

    public setGlobalVariables(): void {}
};