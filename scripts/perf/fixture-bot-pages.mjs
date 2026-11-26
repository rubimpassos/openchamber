// These turns run the real render tool in an isolated Bot conversation.
export const BOT_PAGE_TURNS = [
  {
    id: "verify_bot_retained_proof",
    prompt: "Show the retained bot proof.",
    steps: [{
      text: "Keeping the conversation brief.",
      calls: [{
        name: "openchamber",
        arguments: {
          action: "lead.brief",
          parameters: { brief: "Inspect the sample catalog query and retain the result for this work item." },
        },
      }],
    }, {
      text: "Updating the conversation digest.",
      calls: [{
        name: "openchamber",
        arguments: {
          action: "lead.digest",
          parameters: {
            now: ["The catalog investigation is waiting for its configured identity."],
            news: ["The conversation remains available while execution waits."],
            needsYou: [],
            suggestions: [],
          },
        },
      }],
    }, {
      text: "Showing the measured result.",
      calls: [{
        name: "openchamber_render",
        arguments: {
          action: "render.page",
          parameters: {
            title: "Catalog query proof",
            artifactKind: "evidence",
            ui: 'root = Stack([plot, note])\nplot = Text("![Catalog query](./bot-proof.png)")\nnote = Text("The sample query returns 3 records.")',
          },
        },
      }],
    }],
    answer: "The proof is recorded.\n",
  },
  {
    id: "verify_bot_retained_decision",
    prompt: "Show the retained bot decision.",
    steps: [{
      text: "Showing the alternatives.",
      calls: [{
        name: "openchamber_render",
        arguments: {
          action: "render.page",
          parameters: {
            title: "Catalog query decision",
            artifactKind: "decision",
            awaitAnswer: true,
            html: '<p>Which query should the demonstration keep?</p><button class="oc-button" onclick="openchamber.submit({ query: \'indexed\' }, \'Keep the indexed query\')">Keep the indexed query</button>',
          },
        },
      }],
    }],
    answer: "The visual decision is recorded. Coordinator approval remains separate.\n",
  },
  {
    id: "verify_bot_openui_decision",
    prompt: "Show the retained bot OpenUI decision.",
    steps: [{
      text: "Showing the cache choice.",
      calls: [{
        name: "openchamber_render",
        arguments: {
          action: "render.page",
          parameters: {
            title: "Catalog cache decision",
            artifactKind: "decision",
            awaitAnswer: true,
            ui: 'root = Stack([choice, submit])\nchoice = Choice("cache", ["Enabled", "Disabled"], "Cache")\nsubmit = Button("Keep cache", "primary", "keep-cache")',
          },
        },
      }],
    }],
    answer: "The OpenUI choice is recorded. Coordinator approval remains separate.\n",
  },
];
