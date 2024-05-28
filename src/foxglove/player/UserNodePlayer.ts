// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
//
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2018-2021 Cruise LLC
//
//   This source code is licensed under the Apache License, Version 2.0,
//   found at http://www.apache.org/licenses/LICENSE-2.0
//   You may not use this file except in compliance with the License.

import { isEqual, uniq } from "lodash";
import memoizeWeak from "memoize-weak";
import shallowequal from "shallowequal";
import { v4 as uuidv4 } from "uuid";
import { Mutex } from "async-mutex";

import { Time, compare } from "@foxglove/rostime";
import { ParameterValue } from "../types/studio";
import { generateTypesLib } from "../generateTypesLib";
import { Diagnostic, NodeRegistration, UserNodeLog } from "./types";
import {
  AdvertiseOptions,
  Player,
  PlayerState,
  PlayerStateActiveData,
  PublishPayload,
  SubscribePayload,
  Topic,
  MessageEvent,
  PlayerProblem,
  MessageBlock,
  GlobalVariables,
} from "../types//types";
import { RosDatatypes } from "../types/RosDatatypes";
import { UserNode, UserNodes } from "../types/panels";

const basicDatatypes: RosDatatypes = new Map();
type Args = { topics: Topic[]; datatypes: RosDatatypes };
type LibGeneratorFn = (args: Args) => Promise<string>;

/**
 * LibGenerator memoizes generating a library from topics and datatypes.
 *
 * Calling `update` returns a boolean to indicate if the library was re-generated and the
 * library source code.
 *
 * If the args to update are unchanged (same topics and datatyes), then the previously
 * generated value from `fn` is returned.
 */
class MemoizedLibGenerator {
  private datatypes?: RosDatatypes;
  private topics?: Topic[];
  private fn: LibGeneratorFn;
  private cached?: string;

  public constructor(fn: LibGeneratorFn) {
    this.fn = fn;
  }

  public async update( args: Args ): Promise<{ didUpdate: boolean; lib: string }> {
    if ( args.topics === this.topics && args.datatypes === this.datatypes && this.cached != undefined ) {
      return { didUpdate: false, lib: this.cached };
    }

    const lib = await this.fn(args);
    this.topics = args.topics;
    this.datatypes = args.datatypes;
    this.cached = lib;
    return { didUpdate: true, lib };
  }
}

class MutexLocked<T> {
  private mutex = new Mutex();
  public constructor(private value: T) {}

  public async runExclusive<Result>(
    body: (value: T) => Promise<Result>
  ): Promise<Result> {
    return await this.mutex.runExclusive(async () => await body(this.value));
  }
}

declare let SharedWorker: {
  prototype: SharedWorker;
  new (scriptURL: URL, options?: string | WorkerOptions): SharedWorker;
};

type UserNodeActions = {
  setUserNodeDiagnostics: (
    nodeId: string,
    diagnostics: readonly Diagnostic[]
  ) => void;
  addUserNodeLogs: (nodeId: string, logs: readonly UserNodeLog[]) => void;
  setUserNodeRosLib: (rosLib: string) => void;
  setUserNodeTypesLib: (lib: string) => void;
};

type NodeRegistrationCacheItem = {
  nodeId: string;
  userNode: UserNode;
  result: NodeRegistration;
};

/** Mutable state protected by a mutex lock */
type ProtectedState = {
  nodeRegistrationCache: NodeRegistrationCacheItem[];
  nodeRegistrations: readonly NodeRegistration[];
  lastPlayerStateActiveData?: PlayerStateActiveData;
  userNodes: UserNodes;

  /**
   * Map of output topics to input topics. To produce an output we need to know the input topics
   * that a script requires. When subscribers subscribe to the output topic, the user node player
   * subscribes to the underlying input topics.
   */
  inputsByOutputTopic: Map<string, readonly string[]>;
};

export default class UserNodePlayer implements Player {
  private _player: Player;

  // Datatypes and topics are derived from nodeRegistrations, but memoized so they only change when needed
  private _memoizedNodeDatatypes: readonly RosDatatypes[] = [];
  private _memoizedNodeTopics: readonly Topic[] = [];

  private _subscriptions: SubscribePayload[] = [];
  private _nodeSubscriptions: Record<string, SubscribePayload> = {};

  // listener for state updates
  private _listener?: (arg0: PlayerState) => Promise<void>;

  private _setUserNodeDiagnostics: (
    nodeId: string,
    diagnostics: readonly Diagnostic[]
  ) => void;
  private _addUserNodeLogs: (nodeId: string, logs: UserNodeLog[]) => void;
  private _globalVariables: GlobalVariables = {};

  // Player state changes when the child player invokes our player state listener
  // we may also emit state changes on internal errors
  private _playerState?: PlayerState;

  // The store tracks problems for individual userspace nodes
  // a node may set its own problem or clear its problem
  private _problemStore = new Map<string, PlayerProblem>();

  // keep track of last message on all topics to recompute output topic messages when user nodes change
  private _lastMessageByInputTopic = new Map<string, MessageEvent<unknown>>();
  private _userNodeIdsNeedUpdate = new Set<string>();
  private _globalVariablesChanged = false;
  private _userNodeActions: UserNodeActions;
  private _typesLibGenerator: MemoizedLibGenerator;

  private _protectedState = new MutexLocked<ProtectedState>({
    userNodes: {},
    nodeRegistrations: [],
    nodeRegistrationCache: [],
    lastPlayerStateActiveData: undefined,
    inputsByOutputTopic: new Map(),
  });

  // exposed as a static to allow testing to mock/replace
  private static CreateNodeTransformWorker = (): SharedWorker => {
    // foxglove-depcheck-used: babel-plugin-transform-import-meta
    return new SharedWorker(
      new URL("./nodeTransformerWorker/index", import.meta.url),
      {
        // Although we are using SharedWorkers, we do not actually want to share worker instances
        // between tabs. We achieve this by passing in a unique name.
        name: uuidv4(),
      }
    );
  };

  public constructor(player: Player, userNodeActions: UserNodeActions) {
    this._player = player;
    this._userNodeActions = userNodeActions;
    const { setUserNodeDiagnostics, addUserNodeLogs } = userNodeActions;

    this._setUserNodeDiagnostics = (
      nodeId: string,
      diagnostics: readonly Diagnostic[]
    ) => {
      setUserNodeDiagnostics(nodeId, diagnostics);
    };
    this._addUserNodeLogs = (nodeId: string, logs: UserNodeLog[]) => {
      if (logs.length > 0) {
        addUserNodeLogs(nodeId, logs);
      }
    };

    this._typesLibGenerator = new MemoizedLibGenerator(async (args) => {
      const lib = generateTypesLib({
        topics: args.topics,
        datatypes: new Map([...basicDatatypes as any, ...args.datatypes as any]),
      });

      // Do not prettify the types library as it can cause severe performance
      // degradations. This is OK because the generated types library is
      // read-only and should be rarely read by a human. Further, the
      // not-prettified code is not that bad either. It just lacks the
      // appropriate indentations.
      return lib;
    });
  }

  private _getTopics = memoizeWeak(
    (topics: readonly Topic[], nodeTopics: readonly Topic[]): Topic[] => [
      ...topics,
      ...nodeTopics,
    ]
  );

  private _getDatatypes = memoizeWeak(
    (
      datatypes: RosDatatypes,
      nodeDatatypes: readonly RosDatatypes[]
    ): RosDatatypes => {
      return nodeDatatypes.reduce(
        (allDatatypes: any, userNodeDatatypes: any) =>
          new Map([...allDatatypes, ...userNodeDatatypes]),
        new Map([...datatypes as any, ...basicDatatypes as any])
      );
    }
  );

  private _lastBlockRequest: {
    input?: {
      blocks: readonly (MessageBlock | undefined)[];
      globalVariables: GlobalVariables;
      nodeRegistrations: readonly NodeRegistration[];
    };
    result: (MessageBlock | undefined)[];
  } = { result: [] };

  // Basic memoization by remembering the last values passed to getMessages
  private _lastGetMessagesInput: {
    parsedMessages: readonly MessageEvent<unknown>[];
    globalVariables: GlobalVariables;
    nodeRegistrations: readonly NodeRegistration[];
  } = { parsedMessages: [], globalVariables: {}, nodeRegistrations: [] };
  private _lastGetMessagesResult: {
    parsedMessages: readonly MessageEvent<unknown>[];
  } = {
    parsedMessages: [],
  };

  // Processes input messages through nodes to create messages on output topics
  // Memoized to prevent reprocessing on same input
  private async _getMessages(
    parsedMessages: readonly MessageEvent<unknown>[],
    globalVariables: GlobalVariables,
    nodeRegistrations: readonly NodeRegistration[]
  ): Promise<{
    parsedMessages: readonly MessageEvent<unknown>[];
  }> {
    // prevents from memoizing results for empty requests
    if (parsedMessages.length === 0) {
      return { parsedMessages };
    }
    if (
      shallowequal(this._lastGetMessagesInput, {
        parsedMessages,
        globalVariables,
        nodeRegistrations,
      })
    ) {
      return this._lastGetMessagesResult;
    }
    const parsedMessagesPromises: Promise<MessageEvent<unknown> | undefined>[] =
      [];
    for (const message of parsedMessages) {
      const messagePromises = [];
      for (const nodeRegistration of nodeRegistrations) {
        if (
          this._nodeSubscriptions[nodeRegistration.output.name] &&
          nodeRegistration.inputs.includes(message.topic)
        ) {
          const messagePromise = nodeRegistration.processMessage(
            message,
            globalVariables
          );
          messagePromises.push(messagePromise);
          parsedMessagesPromises.push(messagePromise);
        }
      }
      await Promise.all(messagePromises);
    }

    const nodeParsedMessages = (
      await Promise.all(parsedMessagesPromises)
    ).filter((value): value is MessageEvent<unknown> => value != undefined);

    const result = {
      parsedMessages: parsedMessages
        .concat(nodeParsedMessages)
        .sort((a, b) => compare(a.receiveTime, b.receiveTime)),
    };
    this._lastGetMessagesInput = {
      parsedMessages,
      globalVariables,
      nodeRegistrations,
    };
    this._lastGetMessagesResult = result;
    return result;
  }

  private async _getBlocks(
    blocks: readonly (MessageBlock | undefined)[],
    globalVariables: GlobalVariables,
    nodeRegistrations: readonly NodeRegistration[]
  ): Promise<readonly (MessageBlock | undefined)[]> {
    if (
      shallowequal(this._lastBlockRequest.input, {
        blocks,
        globalVariables,
        nodeRegistrations,
      })
    ) {
      return this._lastBlockRequest.result;
    }

    // If no downstream subscriptions want blocks for our output topics we can just pass through
    // the blocks from the underlying player.
    const fullRegistrations = nodeRegistrations.filter(
      (reg) => this._nodeSubscriptions[reg.output.name]?.preloadType === "full"
    );
    if (fullRegistrations.length === 0) {
      return blocks;
    }

    const allInputTopics = uniq(fullRegistrations.flatMap((reg) => reg.inputs));

    const outputBlocks: (MessageBlock | undefined)[] = [];
    for (const block of blocks) {
      if (!block) {
        outputBlocks.push(block);
        continue;
      }

      // Flatten and re-sort block messages so that nodes see them in the same order
      // as the non-block nodes.
      const messagesByTopic = { ...block.messagesByTopic };
      const blockMessages = allInputTopics
        .flatMap((topic) => messagesByTopic[topic] ?? [])
        .sort((a, b) => compare(a.receiveTime, b.receiveTime));
      for (const nodeRegistration of fullRegistrations) {
        const outTopic = nodeRegistration.output.name;
        // Clear out any previously processed messages that were previously in the output topic.
        // otherwise it will contain duplicates.
        if (messagesByTopic[outTopic] != undefined) {
          messagesByTopic[outTopic] = [];
        }

        for (const message of blockMessages) {
          if (nodeRegistration.inputs.includes(message.topic)) {
            const outputMessage = await nodeRegistration.processMessage(
              message,
              globalVariables
            );
            if (outputMessage) {
              // https://github.com/typescript-eslint/typescript-eslint/issues/6632
              if (!messagesByTopic[outTopic]) {
                messagesByTopic[outTopic] = [];
              }
              messagesByTopic[outTopic]?.push(outputMessage);
            }
          }
        }
      }

      // Note that this size doesn't include the new processed messqges. We may need
      // to recalculate this if it turns out to be important for good cache eviction
      // behavior.
      outputBlocks.push({
        messagesByTopic,
        sizeInBytes: block.sizeInBytes,
      });
    }

    this._lastBlockRequest = {
      input: { blocks, globalVariables, nodeRegistrations },
      result: outputBlocks,
    };

    return outputBlocks;
  }

  public setGlobalVariables(globalVariables: GlobalVariables): void {
    this._globalVariables = globalVariables;
    this._globalVariablesChanged = true;
  }

  // Called when userNode state is updated.
  public async setUserNodes(userNodes: UserNodes): Promise<void> {
    await this._protectedState.runExclusive(async (state) => {
      for (const nodeId of Object.keys(userNodes)) {
        const prevNode = state.userNodes[nodeId];
        const newNode = userNodes[nodeId];
        if (prevNode && newNode && prevNode.sourceCode !== newNode.sourceCode) {
          // if source code of a userNode changed then we need to mark it for re-processing input messages
          this._userNodeIdsNeedUpdate.add(nodeId);
        }
      }
      state.userNodes = userNodes;

      // Prune the node registration cache so it doesn't grow forever.
      // We add one to the count so we don't have to recompile nodes if users undo/redo node changes.
      const maxNodeRegistrationCacheCount = Object.keys(userNodes).length + 1;
      state.nodeRegistrationCache.splice(maxNodeRegistrationCacheCount);
      this._setSubscriptionsUnlocked(this._subscriptions, state);
    });
  }

  // invoked when our child player state changes
  private async _onPlayerState(playerState: PlayerState) {
    try {
      const globalVariables = this._globalVariables;
      const { activeData } = playerState;
      if (!activeData) {
        this._playerState = playerState;
        await this._emitState();
        return;
      }

      const { messages, topics, datatypes } = activeData;

      // If we do not have active player data from a previous call, then our
      // player just spun up, meaning we should re-run our user nodes in case
      // they have inputs that now exist in the current player context.
      const newPlayerState = await this._protectedState.runExclusive(
        async (state) => {
          if (!state.lastPlayerStateActiveData) {
            state.lastPlayerStateActiveData = activeData;
            this._setSubscriptionsUnlocked(this._subscriptions, state);
          } else {
            // Reset node state after seeking
            let shouldReset =
              activeData.lastSeekTime !==
              state.lastPlayerStateActiveData.lastSeekTime;

            // When topics or datatypes change we also need to re-build the nodes so we clear the cache
            if (
              activeData.topics !== state.lastPlayerStateActiveData.topics ||
              activeData.datatypes !== state.lastPlayerStateActiveData.datatypes
            ) {
              shouldReset = true;
              state.nodeRegistrationCache = [];
            }

            state.lastPlayerStateActiveData = activeData;
          }

          const allDatatypes = this._getDatatypes(
            datatypes,
            this._memoizedNodeDatatypes
          );

          /**
           * if nodes have been updated we need to add their previous input messages
           * to our list of messages to be parsed so that subscribers can refresh with
           * the new output topic messages
           */
          const inputTopicsForRecompute = new Set<string>();

          for (const userNodeId of this._userNodeIdsNeedUpdate as any) {
            const nodeRegistration = state.nodeRegistrations.find(
              ({ nodeId }) => nodeId === userNodeId
            );
            if (!nodeRegistration) {
              continue;
            }
            const inputTopics = nodeRegistration.inputs;

            for (const topic of inputTopics) {
              inputTopicsForRecompute.add(topic);
            }
          }

          // if the globalVariables have changed recompute all last messages for the current frame
          // there's no way to know which nodes are affected by the globalVariables change to make this more specific
          if (this._globalVariablesChanged) {
            this._globalVariablesChanged = false;
            for (const inputTopic of this._lastMessageByInputTopic.keys() as any) {
              inputTopicsForRecompute.add(inputTopic);
            }
          }

          // remove topics that already have messages in state, because we won't need to take their last message to process
          // this also removes possible duplicate messages to be parsed
          for (const message of messages) {
            if (inputTopicsForRecompute.has(message.topic)) {
              inputTopicsForRecompute.delete(message.topic);
            }
          }

          const messagesForRecompute: MessageEvent<unknown>[] = [];
          for (const topic of inputTopicsForRecompute as any) {
            const messageForRecompute =
              this._lastMessageByInputTopic.get(topic);
            if (messageForRecompute) {
              messagesForRecompute.push(messageForRecompute);
            }
          }

          this._userNodeIdsNeedUpdate.clear();

          for (const message of messages) {
            this._lastMessageByInputTopic.set(message.topic, message);
          }

          const messagesToBeParsed =
            messagesForRecompute.length > 0
              ? messages.concat(messagesForRecompute)
              : messages;
          const { parsedMessages } = await this._getMessages(
            messagesToBeParsed,
            globalVariables,
            state.nodeRegistrations
          );

          const playerProgress = {
            ...playerState.progress,
          };

          if (playerProgress.messageCache) {
            const newBlocks = await this._getBlocks(
              playerProgress.messageCache.blocks,
              globalVariables,
              state.nodeRegistrations
            );

            playerProgress.messageCache = {
              startTime: playerProgress.messageCache.startTime,
              blocks: newBlocks,
            };
          }

          return {
            ...playerState,
            progress: playerProgress,
            activeData: {
              ...activeData,
              messages: parsedMessages,
              topics: this._getTopics(topics, this._memoizedNodeTopics),
              datatypes: allDatatypes,
            },
          };
        }
      );

      this._playerState = newPlayerState;

      // clear any previous problem we had from making a new player state
      this._problemStore.delete("player-state-update");
    } catch (err: any) {
      this._problemStore.set("player-state-update", {
        severity: "error",
        message: err.message,
        error: err,
      } as any);

      this._playerState = playerState;
    } finally {
      await this._emitState();
    }
  }

  private async _emitState() {
    if (!this._playerState) {
      return;
    }

    // only augment child problems if we have our own problems
    // if neither child or parent have problems we do nothing
    let problems = this._playerState.problems;
    if (this._problemStore.size > 0) {
      problems = (problems ?? []).concat(
        Array.from(this._problemStore.values())
      );
    }

    const playerState: PlayerState = {
      ...this._playerState,
      problems,
    };

    if (this._listener) {
      await this._listener(playerState);
    }
  }

  public setListener(listener: NonNullable<UserNodePlayer["_listener"]>): void {
    this._listener = listener;

    // Delay _player.setListener until our setListener is called because setListener in some cases
    // triggers initialization logic and remote requests. This is an unfortunate API behavior and
    // naming choice, but it's better for us not to do trigger this logic in the constructor.
    this._player.setListener(async (state) => await this._onPlayerState(state));
  }

  public setSubscriptions(subscriptions: SubscribePayload[]): void {
    this._subscriptions = subscriptions;
    this._protectedState
      .runExclusive(async (state) => {
        this._setSubscriptionsUnlocked(subscriptions, state);
      })
  }

  private _setSubscriptionsUnlocked(
    subscriptions: SubscribePayload[],
    state: ProtectedState
  ): void {
    const nodeSubscriptions: Record<string, SubscribePayload> = {};
    const realTopicSubscriptions: SubscribePayload[] = [];

    // For each subscription, identify required input topics by looking up the subscribed topic in
    // the map of output topics -> inputs. Add these required input topics to the set of topic
    // subscriptions to the underlying player.
    for (const subscription of subscriptions) {
      const inputs = state.inputsByOutputTopic.get(subscription.topic);
      if (!inputs) {
        nodeSubscriptions[subscription.topic] = subscription;
        realTopicSubscriptions.push(subscription);
        continue;
      }

      // If the inputs array is empty then we don't have anything to subscribe to for this output
      if (inputs.length === 0) {
        continue;
      }

      nodeSubscriptions[subscription.topic] = subscription;
      for (const inputTopic of inputs) {
        realTopicSubscriptions.push({
          topic: inputTopic,
          preloadType: subscription.preloadType ?? "partial",
        });
      }
    }

    this._nodeSubscriptions = nodeSubscriptions;
    this._player.setSubscriptions(realTopicSubscriptions);
  }

  public close = (): void => {
    void this._protectedState.runExclusive(async (state) => {
      for (const nodeRegistration of state.nodeRegistrations) {
        nodeRegistration.terminate();
      }
    });
    this._player.close();
  };

  public setPublishers(publishers: AdvertiseOptions[]): void {
    this._player.setPublishers(publishers);
  }

  public setParameter(key: string, value: ParameterValue): void {
    this._player.setParameter(key, value);
  }

  public publish(request: PublishPayload): void {
    this._player.publish(request);
  }

  public async callService(
    service: string,
    request: unknown
  ): Promise<unknown> {
    return await this._player.callService(service, request);
  }

  public startPlayback(): void {
    this._player.startPlayback?.();
  }

  public pausePlayback(): void {
    this._player.pausePlayback?.();
  }

  public playUntil(time: Time): void {
    if (this._player.playUntil) {
      this._player.playUntil(time);
      return;
    }
    this._player.seekPlayback?.(time);
  }

  public setPlaybackSpeed(speed: number): void {
    this._player.setPlaybackSpeed?.(speed);
  }

  public seekPlayback(time: Time, backfillDuration?: Time): void {
    this._player.seekPlayback?.(time, backfillDuration);
  }
}
