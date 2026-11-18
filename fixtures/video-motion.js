import assert from 'node:assert/strict'

export function motionScriptFixture() {
  const briefs = [
    ['intro', 'Choose one experiment', ['Choose a model and a dataset that you want to compare.', 'Give the run its own settings so you can repeat the result.', 'A report shows what changed from the last run.']],
    ['use', 'Pick the input', ['Start from a small dataset with the ratings you already have.', 'Point the run at that data and choose the experiment settings.', 'Save those settings beside the report.']],
    ['use', 'Start the run', ['Send the settings to the entry point to start the run.', 'It loads the dataset before it starts training the model.', 'The run can be repeated with the same settings.']],
    ['flow', 'Pass the settings', ['The entry point reads the settings from the experiment configuration.', 'The trainer uses those settings to run the model.', 'Each run saves the measurements needed to compare the results.']],
    ['flow', 'Run the experiment', ['The trainer uses the supplied model for the training run.', 'It records evaluation results after the model has trained.', 'The report includes the metrics you selected.']],
    ['detail', 'Keep parameters separate', ['The entry point owns the settings and starts the trainer.', 'The trainer owns model execution and returns the measurements.', 'That separation lets one entry point start different runs.']],
    ['outro', 'Compare the results', ['Open a report to see how the model performed.', 'Now change a setting and compare another run.', 'Keep the data fixed when the setting is the part you want to test.']],
  ]
  return { title: 'One training experiment', scenes: briefs.map(([kind, title, lines]) => ({
    kind, title, headline: title,
    beats: lines.map((narration, i) => ({ narration,
      brief: ['Introduce the experiment input.', 'Reveal the related action.', 'Show what the action produces.'][i] })),
  })) }
}

export function motionDesignFixture(scene) {
  return { layout: 'row', transition: 'slide', elements: [
    { id: 'theme', kind: 'heading', text: scene.title, beat: 1 },
    { id: 'result', kind: 'chip', text: 'Experiment report', beat: 2 },
  ], actions: [{ do: 'highlight', target: 'result', beat: 3 }] }
}

export const editorialDocumentText = `ExampleLab helps researchers compare recommendation experiments using shared configuration, data handling, training, and evaluation.
It provides reusable trainers so model experiments can share one measurement procedure.
An entry point reads configuration and data, then calls the trainer to train the model and return evaluation measurements.`

export function editorialBriefFixture() {
  return {
    audience: 'Researchers comparing recommendation models.',
    problem: 'Different experiment implementations make model comparisons harder to interpret.',
    value: 'Shared training and evaluation let researchers compare experiments using one measurement procedure.',
    angle: 'Introduce the shared experiment environment and show how the entry point and trainer support it.',
    facts: [
      { id: 'fact_purpose', kind: 'purpose', claim: 'ExampleLab helps researchers compare recommendation experiments.',
        source: 'wiki', quote: 'ExampleLab helps researchers compare recommendation experiments using shared configuration, data handling, training, and evaluation.' },
      { id: 'fact_trainer', kind: 'feature', claim: 'Reusable trainers give model experiments a shared measurement procedure.',
        source: 'wiki', quote: 'It provides reusable trainers so model experiments can share one measurement procedure.' },
      { id: 'fact_architecture', kind: 'architecture', claim: 'The entry point passes configuration and data to the trainer and receives evaluation measurements.',
        source: 'wiki', quote: 'An entry point reads configuration and data, then calls the trainer to train the model and return evaluation measurements.' },
    ], selectedFeatures: ['fact_trainer'], architecture: ['entry', 'trainer'], motivationFact: null,
    omissions: ['The original author motivation is undocumented.'],
  }
}

export function promotionalScriptFixture() {
  const scenes = [
    ['problem', 'Compare experiments', [
      'Recommendation researchers need to compare models under the same experimental conditions.',
      'Different training implementations can make those results difficult to compare.',
      'A shared measurement procedure makes the comparison easier to interpret.',
    ]],
    ['intro', 'Meet ExampleLab', [
      'ExampleLab gives recommendation researchers one environment for running those comparisons.',
      'It brings configuration, data handling, training, and evaluation together.',
      'The project supports research experiments with a common structure.',
    ]],
    ['feature', 'Reuse the trainer', [
      'Its reusable trainers keep model experiments on the same execution path.',
      'Models share the procedure that produces their evaluation measurements.',
      'Researchers can compare the resulting experiments using that common procedure.',
    ]],
    ['feature', 'Keep settings explicit', [
      'Configuration describes the settings supplied to each experiment.',
      'Data handling prepares the input that the trainer receives.',
      'Both remain explicit parts of the same research environment.',
    ]],
    ['architecture', 'Two main responsibilities', [
      'The entry point reads the experiment configuration and data.',
      'It passes that information to the reusable trainer.',
      'The trainer executes the model and returns the evaluation measurements.',
    ]],
    ['architecture', 'Connect design to value', [
      'That division connects experiment setup with a shared training procedure.',
      'Each component has a distinct responsibility within the comparison.',
      'The resulting measurements come from the same execution structure.',
    ]],
    ['outro', 'Who should explore it', [
      'Researchers comparing recommendation models are the audience for this project.',
      'Its main value is the shared experiment and measurement structure.',
      'That is the part to examine when evaluating its fit.',
    ]],
  ]
  return { title: 'ExampleLab for recommendation research', scenes: scenes.map(([kind, title, lines]) => ({
    kind, title, headline: title, beats: lines.map((narration, i) => ({ narration,
      brief: ['Introduce the specific project problem.', 'Reveal the supported capability.', 'Connect that capability to its consequence.'][i] })),
  })) }
}

export function motionModelResponse(system, prompt) {
  if (system.includes('REPOSITORY EDITOR')) return editorialBriefFixture()
  if (system.includes('STORY EDITOR')) return { approved: true, issues: [] }
  if (system.includes('You are the DIRECTOR')) return promotionalScriptFixture()
  if (system.includes('MOTION DESIGNER')) return motionDesignFixture(JSON.parse(prompt).scene)
  if (system.includes('FILM EDITOR')) return { repairs: [] }
  assert.fail('Unexpected motion pipeline prompt')
}

export const motionPipelineCalls = () => promotionalScriptFixture().scenes.length + 4
