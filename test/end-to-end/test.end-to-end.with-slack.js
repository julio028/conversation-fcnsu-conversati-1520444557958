'use strict';

const assert = require('assert');
const openwhisk = require('openwhisk');

const safeExtractErrorMessage = require('./../utils/helper-methods.js').safeExtractErrorMessage;
const clearContextDb = require('./../utils/cloudant-utils.js').clearContextDb;

const slackBindings = require('./../resources/bindings/slack-bindings.json').slack;
const cloudantBindings = require('./../resources/bindings/cloudant-bindings.json');

const carDashboardReplyWelcome = 'Hi. It looks like a nice drive today. What would you like me to do?  ';
const carDashboardReplyLights = "I'll turn on the lights for you.";

const buttonMessageInputText = 'Buy me a shirt please.';
const buttonMessageResponse = 'What shirt size would you like?';
const updateMessageResponse = "I'll buy a small shirt for you.";

const pipelineName = process.env.__TEST_PIPELINE_NAME;

/**
 * Slack prerequisites test suite verifies the Slack package is properly deployed in OpenWhisk
 */
describe('End-to-End tests: Slack prerequisites', () => {
  const ow = openwhisk();

  const requiredActions = [
    `${pipelineName}_slack/post`,
    `${pipelineName}_slack/receive`,
    `${pipelineName}_slack/deploy`,
    `${pipelineName}_starter-code/normalize-conversation-for-slack`,
    `${pipelineName}_starter-code/normalize-slack-for-conversation`
  ];

  requiredActions.forEach(action => {
    it(`${action} action is deployed in OpenWhisk namespace`, () => {
      return ow.actions.get({ name: action }).then(
        () => {},
        error => {
          assert(
            false,
            `${action}, ${safeExtractErrorMessage(error)} Try running setup scripts again.`
          );
        }
      );
    });
  });
});

describe('End-to-End tests: with Slack package', () => {
  const ow = openwhisk();

  const noContextPipeline = 'test-pipeline-slack';
  const contextPipeline = 'test-pipeline-context-slack';

  let params;
  let expectedResult;
  let attachmentData;
  let attachmentPayload;

  const expAfterTurn2 = {
    channel: slackBindings.channel,
    text: carDashboardReplyLights,
    as_user: 'true',
    token: slackBindings.bot_access_token,
    ts: 'XXXXXXXXX.XXXXXX'
  };

  beforeEach(() => {
    params = {
      token: slackBindings.verification_token,
      team_id: 'TXXXXXXXX',
      api_app_id: 'AXXXXXXXX',
      event: {
        type: 'message',
        channel: slackBindings.channel,
        user: 'UXXXXXXXXXX',
        text: 'Message coming from end to end test.',
        ts: 'XXXXXXXXX.XXXXXX'
      },
      type: 'event_callback',
      authed_users: ['UXXXXXXX1', 'UXXXXXXX2'],
      event_id: 'EvXXXXXXXX',
      event_time: 'XXXXXXXXXX'
    };

    expectedResult = {
      channel: slackBindings.channel,
      text: carDashboardReplyWelcome,
      as_user: 'true',
      token: slackBindings.bot_access_token,
      ts: 'XXXXXXXXX.XXXXXX'
    };

    attachmentData = [
      {
        actions: [
          {
            name: 'shirt_size_small',
            text: 'Small',
            type: 'button',
            value: 'small'
          },
          {
            name: 'shirt_size_medium',
            text: 'Medium',
            type: 'button',
            value: 'medium'
          },
          {
            name: 'shirt_size_large',
            text: 'Large',
            type: 'button',
            value: 'large'
          }
        ],
        fallback: 'Sorry! We cannot support buttons at the moment. Please type in: small, medium, or large.',
        callback_id: 'shirt_size'
      }
    ];

    attachmentPayload = {
      actions: [
        {
          name: 'shirt_size_small',
          value: 'small',
          type: 'button'
        }
      ],
      team: {
        name: 'test_team',
        id: 'TXXXXXXXX'
      },
      channel: {
        name: 'test_channel',
        id: slackBindings.channel
      },
      user: {
        name: 'test_user',
        id: 'UXXXXXXXXXX'
      },
      original_message: {
        text: buttonMessageInputText
      },
      callback_id: 'shirt_size',
      token: slackBindings.verification_token
    };

    clearContextDb(cloudantBindings.database.context.name, cloudantBindings.url);
  });

  // Under validated circumstances, the channel (mocked parameters here) will send parameters
  // to slack/receive. The architecture will flow the response to slack/post, and slack/post will
  // send its response to this ow.action invocation. No context is used in this test.
  it('validate when conversation is text input to text output', () => {
    return ow.actions
      .invoke({
        name: noContextPipeline,
        result: true,
        blocking: true,
        params
      })
      .then(
        result => {
          assert.deepEqual(result, expectedResult);
        },
        error => {
          assert(false, safeExtractErrorMessage(error));
        }
      );
  })
    .timeout(5000)
    .retries(4);

  // Under validated circumstances, context package should load and save context
  // to complete a single-turn conversation successfully.
  it.skip('context pipeline works for single Conversation turn', () => {
    return clearContextDb(
      cloudantBindings.database.context.name,
      cloudantBindings.url
    ).then(() => {
      return ow.actions
        .invoke({
          name: contextPipeline,
          result: true,
          blocking: true,
          params
        })
        .then(
          result => {
            return assert.deepEqual(result, expectedResult);
          },
          error => {
            return assert(false, safeExtractErrorMessage(error));
          }
        );
    });
  });

  // Under validated circumstances, context package should load and save context
  // to complete a multi-turn conversation successfully.
  it.skip('context pipeline works for multiple Conversation turns', () => {
    return clearContextDb(
      cloudantBindings.database.context.name,
      cloudantBindings.url
    ).then(() => {
      return ow.actions
        .invoke({
          name: contextPipeline,
          result: true,
          blocking: true,
          params
        })
        .then(result => {
          assert.deepEqual(result, expectedResult);

          // Change the input text for the second turn.
          params.event.text = 'Turn on the lights';

          // Invoke the context pipeline sequence again.
          // The context package should read the updated context from the previous turn.
          return ow.actions.invoke({
            name: contextPipeline,
            result: true,
            blocking: true,
            params
          });
        })
        .then(result => {
          return assert.deepEqual(result, expAfterTurn2);
        })
        .catch(err => {
          return assert(false, safeExtractErrorMessage(err));
        });
    });
  });

  // Using a context database, if the user sends a text message that triggers an interactive
  //  response from Conversation, that response should accurately be converted to a
  //  Slack attached message. (In a clean database, the first message is always a welcome
  //  message, so the second message is the message to validate.)
  it.skip(
    'validate when conversation is text input to attached message output',
    () => {
      expectedResult.text = buttonMessageResponse;
      expectedResult.attachments = attachmentData;
      delete expectedResult.ts;

      return ow.actions
        .invoke({
          name: contextPipeline,
          result: true,
          blocking: true,
          params
        })
        .then(() => {
          params.event.text = buttonMessageInputText;

          return ow.actions.invoke({
            name: contextPipeline,
            result: true,
            blocking: true,
            params
          });
        })
        .then(result => {
          return assert.deepEqual(result, expectedResult);
        })
        .catch(error => {
          assert(false, safeExtractErrorMessage(error));
        });
    }
  );

  // This is a continutaion from the previous test case. If the user triggers an attached message
  //  response, then the response sent from Conversation is used to replace the buttons row that
  //  the user clicks. Here, only the third message is validated. (See the previous test case for
  //  validation on the first two messages.)
  it.skip(
    'validate when conversation is attached message response input to message update output',
    () => {
      expectedResult.text = buttonMessageInputText;
      expectedResult.attachments = [{ text: updateMessageResponse }];
      delete expectedResult.ts;

      return ow.actions
        .invoke({
          name: contextPipeline,
          result: true,
          blocking: true,
          params
        })
        .then(() => {
          params.event.text = buttonMessageInputText;

          return ow.actions.invoke({
            name: contextPipeline,
            result: true,
            blocking: true,
            params
          });
        })
        .then(() => {
          params = {
            payload: JSON.stringify(attachmentPayload)
          };

          return ow.actions.invoke({
            name: contextPipeline,
            result: true,
            blocking: true,
            params
          });
        })
        .then(result => {
          return assert.deepEqual(result, expectedResult);
        })
        .catch(error => {
          return assert(false, error);
        });
    }
  );
});
