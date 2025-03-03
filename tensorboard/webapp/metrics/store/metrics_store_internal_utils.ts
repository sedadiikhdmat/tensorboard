/* Copyright 2020 The TensorFlow Authors. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
==============================================================================*/
/**
 * @fileoverview Utilities used internally by the Metrics feature's NgRx store.
 */

import {DataLoadState} from '../../types/data';
import {isSampledPlugin, PluginType, SampledPluginType} from '../data_source';
import {
  CardId,
  CardMetadata,
  CardUniqueInfo,
  LinkedTime,
  NonPinnedCardId,
} from '../internal_types';
import {
  CardMetadataMap,
  CardStepIndexMap,
  CardStepIndexMetaData,
  CardToPinnedCard,
  MetricsState,
  PinnedCardToCard,
  RunToLoadState,
  TagMetadata,
  TimeSeriesData,
  TimeSeriesLoadables,
} from './metrics_types';

type ResolvedPinPartialState = Pick<
  MetricsState,
  | 'cardMetadataMap'
  | 'cardToPinnedCopy'
  | 'pinnedCardToOriginal'
  | 'cardStepIndex'
>;

const DISTANCE_RATIO = 0.1;

/**
 * Returns the loadable information for a specific tag, containing its series
 * data and load state. Returns `null` when the requested tag has no initial
 * loadable in `timeSeriesData`.
 */
export function getTimeSeriesLoadable(
  timeSeriesData: TimeSeriesData,
  plugin: PluginType,
  tag: string,
  sample?: number
): TimeSeriesLoadables[typeof plugin] | null {
  const pluginData = timeSeriesData[plugin];
  if (!pluginData.hasOwnProperty(tag)) {
    return null;
  }
  if (isSampledPlugin(plugin)) {
    if (!timeSeriesData[plugin][tag].hasOwnProperty(sample!)) {
      return null;
    }
    return timeSeriesData[plugin][tag][sample!];
  }
  return timeSeriesData[plugin][tag];
}

/**
 * Create a new plugin data with new references to a new time series loadable.
 * The return object is a shallow clone, so consumers must clone fields as
 * needed.
 */
export function createPluginDataWithLoadable(
  timeSeriesData: TimeSeriesData,
  plugin: PluginType,
  tag: string,
  sample?: number
): TimeSeriesData[typeof plugin] {
  if (isSampledPlugin(plugin)) {
    const pluginData = {...timeSeriesData[plugin]};
    const tagData = createSampledTagDataWithLoadable<typeof plugin>(
      pluginData,
      tag,
      sample!
    );
    pluginData[tag] = tagData;
    return pluginData;
  }

  const pluginData = {...timeSeriesData[plugin]};
  const hasTag = pluginData.hasOwnProperty(tag);
  pluginData[tag] = hasTag
    ? {...pluginData[tag]}
    : buildTimeSeriesLoadable<typeof plugin>();
  return pluginData;
}

function createSampledTagDataWithLoadable<P extends SampledPluginType>(
  pluginData: TimeSeriesData[SampledPluginType],
  tag: string,
  sample: number
) {
  const hasTag = pluginData.hasOwnProperty(tag);
  const tagData = hasTag ? {...pluginData[tag]} : {};

  const hasSample = tagData.hasOwnProperty(sample);
  tagData[sample] = hasSample
    ? {...tagData[sample]}
    : buildTimeSeriesLoadable<P>();
  return tagData;
}

function buildTimeSeriesLoadable<
  P extends PluginType
>(): TimeSeriesLoadables[P] {
  return {
    runToSeries: {},
    runToLoadState: {},
  };
}

/**
 * Note: do not rely on the implementation details of these ID generators below.
 * Clients should operate on `CardId`s, whose type may be open to change.
 */

export function getCardId(cardMetadata: CardMetadata) {
  return JSON.stringify(cardMetadata);
}

export function getPinnedCardId(baseCardId: CardId) {
  return JSON.stringify({baseCardId});
}

/**
 * Creates a RunToLoadState with a specific load state for all specified runs.
 */
export function createRunToLoadState(
  loadState: DataLoadState,
  runs: string[],
  prevRunToLoadState?: RunToLoadState
): RunToLoadState {
  const runToLoadState = {...prevRunToLoadState} as RunToLoadState;
  for (const run of runs) {
    runToLoadState[run] = loadState;
  }
  return runToLoadState;
}

export function getRunIds(
  tagMetadata: TagMetadata,
  plugin: PluginType,
  tag: string,
  sample?: number
) {
  if (isSampledPlugin(plugin)) {
    const tagRunSampledInfo = tagMetadata[plugin].tagRunSampledInfo;
    if (!tagRunSampledInfo.hasOwnProperty(tag)) {
      return [];
    }
    const runIds = Object.keys(tagRunSampledInfo[tag]);
    return runIds.filter((runId) => {
      return sample! < tagRunSampledInfo[tag][runId].maxSamplesPerStep;
    });
  }
  const tagToRunIds = tagMetadata[plugin].tagToRuns;
  return tagToRunIds.hasOwnProperty(tag) ? tagToRunIds[tag] : [];
}

/**
 * Returns whether the CardMetadata exactly matches the pinned card from
 * storage.
 */
function cardMatchesCardUniqueInfo(
  cardMetadata: CardMetadata,
  cardUniqueInfo: CardUniqueInfo
): boolean {
  const noRunId = !cardMetadata.runId && !cardUniqueInfo.runId;
  return (
    cardMetadata.plugin === cardUniqueInfo.plugin &&
    cardMetadata.tag === cardUniqueInfo.tag &&
    cardMetadata.sample === cardUniqueInfo.sample &&
    (cardMetadata.runId === cardUniqueInfo.runId || noRunId)
  );
}

/**
 * Attempts to resolve the imported pins against the list of non-pinned cards
 * provided. Returns the resulting state.
 *
 * Note: this assumes input has already been sanitized and validated. Untrusted
 * data from URLs must be cleaned before being passed to the store.
 */
export function buildOrReturnStateWithUnresolvedImportedPins(
  unresolvedImportedPinnedCards: CardUniqueInfo[],
  nonPinnedCards: NonPinnedCardId[],
  cardMetadataMap: CardMetadataMap,
  cardToPinnedCopy: CardToPinnedCard,
  pinnedCardToOriginal: PinnedCardToCard,
  cardStepIndexMap: CardStepIndexMap
): ResolvedPinPartialState & {unresolvedImportedPinnedCards: CardUniqueInfo[]} {
  const unresolvedPinSet = new Set(unresolvedImportedPinnedCards);
  const nonPinnedCardsWithMatch = [];
  for (const unresolvedPin of unresolvedImportedPinnedCards) {
    for (const nonPinnedCardId of nonPinnedCards) {
      const cardMetadata = cardMetadataMap[nonPinnedCardId];
      if (cardMatchesCardUniqueInfo(cardMetadata, unresolvedPin)) {
        nonPinnedCardsWithMatch.push(nonPinnedCardId);
        unresolvedPinSet.delete(unresolvedPin);
        break;
      }
    }
  }

  if (!nonPinnedCardsWithMatch.length) {
    return {
      unresolvedImportedPinnedCards,
      cardMetadataMap,
      cardToPinnedCopy,
      pinnedCardToOriginal,
      cardStepIndex: cardStepIndexMap,
    };
  }

  let stateWithResolvedPins = {
    cardToPinnedCopy,
    pinnedCardToOriginal,
    cardStepIndex: cardStepIndexMap,
    cardMetadataMap,
  };
  for (const cardToPin of nonPinnedCardsWithMatch) {
    stateWithResolvedPins = buildOrReturnStateWithPinnedCopy(
      cardToPin,
      stateWithResolvedPins.cardToPinnedCopy,
      stateWithResolvedPins.pinnedCardToOriginal,
      stateWithResolvedPins.cardStepIndex,
      stateWithResolvedPins.cardMetadataMap
    );
  }

  return {
    ...stateWithResolvedPins,
    unresolvedImportedPinnedCards: [...unresolvedPinSet],
  };
}

/**
 * Return the state produced by creating a new pinned copy of the provided card.
 * May throw if the card provided has no metadata.
 */
export function buildOrReturnStateWithPinnedCopy(
  cardId: NonPinnedCardId,
  cardToPinnedCopy: CardToPinnedCard,
  pinnedCardToOriginal: PinnedCardToCard,
  cardStepIndexMap: CardStepIndexMap,
  cardMetadataMap: CardMetadataMap
): ResolvedPinPartialState {
  // No-op if the card already has a pinned copy.
  if (cardToPinnedCopy.has(cardId)) {
    return {
      cardToPinnedCopy,
      pinnedCardToOriginal,
      cardStepIndex: cardStepIndexMap,
      cardMetadataMap,
    };
  }

  const nextCardToPinnedCopy = new Map(cardToPinnedCopy);
  const nextPinnedCardToOriginal = new Map(pinnedCardToOriginal);
  const nextCardStepIndexMap = {...cardStepIndexMap};
  const nextCardMetadataMap = {...cardMetadataMap};

  // Create a pinned copy. Copies step index from the original card.
  const pinnedCardId = getPinnedCardId(cardId);
  nextCardToPinnedCopy.set(cardId, pinnedCardId);
  nextPinnedCardToOriginal.set(pinnedCardId, cardId);
  if (cardStepIndexMap.hasOwnProperty(cardId)) {
    nextCardStepIndexMap[pinnedCardId] = cardStepIndexMap[cardId];
  }

  const metadata = cardMetadataMap[cardId];
  if (!metadata) {
    throw new Error('Cannot pin a card without metadata');
  }
  nextCardMetadataMap[pinnedCardId] = metadata;

  return {
    cardToPinnedCopy: nextCardToPinnedCopy,
    pinnedCardToOriginal: nextPinnedCardToOriginal,
    cardStepIndex: nextCardStepIndexMap,
    cardMetadataMap: nextCardMetadataMap,
  };
}

/**
 * Determines which pinned cards should continue to be present in the metrics
 * state after an update to the set of experiments/tags/cards. Pinned cards are
 * removed if their corresponding card is no longer present in the state (perhaps
 * because the corresponding experiment and tag have been removed from the
 * comparison). Pinned cards are added if they are previously pinned by the user.
 * It generates new cardToPinnedCopy, pinnedCardToOriginal maps to reflect the new
 * set of pinned cards. It generates a cardMetadataMap object that is a combination
 * of the input nextCardMetadataMap as well as metadata for the new set of pinned cards.
 * @param previousCardToPinnedCopyCache The set of pinned cards that were previously
 *  pinned by the user within the same time-namespace. This is a superset of pinned
 *  cards in cardToPinnedCopy and the set remains the same after the update.
 * @param nextCardMetadataMap Metadata for all cards that will be present after
 *  the update (we assume it does not yet include metadata for pinned copies of cards).
 * @param nextCardList The set of base cards that will continue to be present in the
 *  dashboard after the update.
 */
export function generateNextPinnedCardMappings(
  previousCardToPinnedCopyCache: CardToPinnedCard,
  nextCardMetadataMap: CardMetadataMap,
  nextCardList: CardId[]
) {
  const nextCardToPinnedCopy = new Map() as CardToPinnedCard;
  const nextPinnedCardToOriginal = new Map() as PinnedCardToCard;
  const pinnedCardMetadataMap = {} as CardMetadataMap;
  previousCardToPinnedCopyCache.forEach((pinnedCardId, cardId) => {
    if (nextCardList.indexOf(cardId) !== -1) {
      nextCardToPinnedCopy.set(cardId, pinnedCardId);
      nextPinnedCardToOriginal.set(pinnedCardId, cardId);
      pinnedCardMetadataMap[pinnedCardId] = nextCardMetadataMap[cardId];
    }
  });

  return {
    nextCardToPinnedCopy,
    nextPinnedCardToOriginal,
    pinnedCardMetadataMap,
  };
}

/**
 * Removes cards not in cardMetadataMap from cardStepIndex mapping.
 */
export function generateNextCardStepIndex(
  previousCardStepIndex: CardStepIndexMap,
  nextCardMetadataMap: CardMetadataMap
): CardStepIndexMap {
  const nextCardStepIndexMap = {} as CardStepIndexMap;
  Object.entries(previousCardStepIndex).forEach(([cardId, step]) => {
    if (nextCardMetadataMap[cardId]) {
      nextCardStepIndexMap[cardId] = step;
    }
  });
  return nextCardStepIndexMap;
}

/**
 * The maximum number of pins we allow the user to create. This is intentionally
 * finite at the moment to mitigate super long URL lengths, until there is more
 * durable value storage for pins.
 * https://github.com/tensorflow/tensorboard/issues/4242
 */
const util = {
  MAX_PIN_COUNT: 10,
};

export function canCreateNewPins(state: MetricsState) {
  const pinCountInURL =
    state.pinnedCardToOriginal.size +
    state.unresolvedImportedPinnedCards.length;
  return pinCountInURL < util.MAX_PIN_COUNT;
}
/**
 * Sets cardStepIndex for image card based on selected time.
 */
export function generateNextCardStepIndexFromSelectedTime(
  previousCardStepIndex: CardStepIndexMap,
  cardMetadataMap: CardMetadataMap,
  timeSeriesData: TimeSeriesData,
  selectedTime: LinkedTime
): CardStepIndexMap {
  let nextCardStepIndex = {...previousCardStepIndex};

  Object.keys(previousCardStepIndex).forEach((cardId) => {
    if (!cardId.includes('"plugin":"images"')) return;

    const steps = getImageCardSteps(cardId, cardMetadataMap, timeSeriesData);

    let nextStepIndexMetaData = null;
    if (selectedTime.end === null) {
      // Single Selection
      nextStepIndexMetaData = getNextImageCardStepIndexFromSingleSelection(
        selectedTime.start.step,
        steps
      );
    } else {
      // Range Selection
      const currentStepIndex = previousCardStepIndex[cardId]!.index!;
      const step = steps[currentStepIndex];
      const selectedSteps = getSelectedSteps(selectedTime, steps);

      nextStepIndexMetaData = getNextImageCardStepIndexFromRangeSelection(
        selectedSteps,
        steps,
        step
      );
    }

    if (nextStepIndexMetaData !== null) {
      nextCardStepIndex[cardId] = nextStepIndexMetaData;
    }
  });

  return nextCardStepIndex;
}

/**
 * Returns steps of an image card.
 */
export function getImageCardSteps(
  cardId: string,
  cardMetadataMap: CardMetadataMap,
  timeSeriesData: TimeSeriesData
): number[] {
  if (!cardMetadataMap.hasOwnProperty(cardId)) {
    return [];
  }

  const {plugin, tag, sample, runId} = cardMetadataMap[cardId];
  if (runId === null) {
    return [];
  }

  const loadable = getTimeSeriesLoadable(timeSeriesData, plugin, tag, sample);
  if (loadable === null || !loadable.runToSeries.hasOwnProperty(runId)) {
    return [];
  }

  return loadable.runToSeries[runId].map((stepDatum) => stepDatum.step);
}

/**
 * Returns the subset of steps that are within selected time given a list of steps
 */
function getSelectedSteps(selectedTime: LinkedTime | null, steps: number[]) {
  if (!selectedTime) return [];

  // Single selection: returns start step if matching any step in the list, otherwise returns nothing.
  if (selectedTime.end === null) {
    if (steps.indexOf(selectedTime.start.step) !== -1)
      return [selectedTime.start.step];
    return [];
  }

  // Range selection.
  const selectedStepsInRange = [];
  for (const step of steps) {
    if (step >= selectedTime.start.step && step <= selectedTime.end.step) {
      selectedStepsInRange.push(step);
    }
  }
  return selectedStepsInRange;
}

/**
 * Gets next stepIndex for an image card based on single selection. Returns null if nothing should change.
 * @param selectedStep The selected step from selected time. It is equivalent to start step here
 *  since there is no `end` in selected time when it is single seleciton.
 */
function getNextImageCardStepIndexFromSingleSelection(
  selectedStep: number,
  steps: number[]
): CardStepIndexMetaData | null {
  // Checks exact match.
  const maybeMatchedStepIndex = steps.indexOf(selectedStep);
  if (maybeMatchedStepIndex !== -1) {
    return {index: maybeMatchedStepIndex, isClosest: false};
  }

  // Checks if start step is "close" enough to a step value and move it
  for (let i = 0; i < steps.length - 1; i++) {
    const currentStep = steps[i];
    const nextStep = steps[i + 1];
    const distance = (nextStep - currentStep) * DISTANCE_RATIO;

    if (selectedStep < currentStep) return null;
    if (selectedStep > nextStep) continue;

    if (selectedStep - currentStep <= distance) {
      return {index: i, isClosest: true};
    }
    if (nextStep - selectedStep <= distance) {
      return {index: i + 1, isClosest: true};
    }
  }

  return null;
}

/**
 * Gets next stepIndex for an image card based on range selection. Returns null if nothing should change.
 * @param selectedSteps The selected steps from selected time. Empty array means no steps within range.
 * @param steps The steps in an image card.
 * @param step The step where the current step index locates.
 */
function getNextImageCardStepIndexFromRangeSelection(
  selectedSteps: number[],
  steps: number[],
  step: number
): CardStepIndexMetaData | null {
  if (selectedSteps.length === 0) return null;

  const firstSelectedStep = selectedSteps[0];
  const lastSelectedStep = selectedSteps[selectedSteps.length - 1];

  // Updates step index to the closest index if it is outside the range.
  if (step > lastSelectedStep) {
    return {index: steps.indexOf(lastSelectedStep), isClosest: false};
  }
  if (step < firstSelectedStep) {
    return {index: steps.indexOf(firstSelectedStep), isClosest: false};
  }

  // Does not update index when it is in selected range.
  return null;
}

export const TEST_ONLY = {
  getImageCardSteps,
  getSelectedSteps,
  getNextImageCardStepIndexFromRangeSelection,
  getNextImageCardStepIndexFromSingleSelection,
  generateNextCardStepIndexFromSelectedTime,
  util,
};
