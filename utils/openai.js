const { Configuration, OpenAIApi } = require("openai");
const axios = require('axios');

exports.getEmbedding = async (openAiKey, input) => {
    const configuration = new Configuration({
        apiKey: openAiKey,
      });
      const openai = new OpenAIApi(configuration);
      let embeddingResponse;
      try {
        embeddingResponse = await openai.createEmbedding({
            model: 'text-embedding-ada-002',
            input,
          })    
      } catch (err) {
        console.error('Axios err', err.response && err.response.data ? err.response.data : err);
        return false;
      }
      
      return embeddingResponse.data.data[0].embedding;
}

exports.createContextBasedPrompt = (query, contexts) => {
  let prompt = `"""Answer the question as truthfully as possible using the provided contexts, and if the answer cannot be found by combining the contexts below, say "I don't know". Provide as much detail as you can in your response. Also state all the context numbers that helped to provide you with the answer.
  
  The return format must be stringified JSON in the following format: {
      "answer": answer goes here
      "provider": array of the context numbers in escaped quotes that provided you the answer here
  }
`;
  for (let i = 0; i < contexts.length; ++i) {
      prompt += `Context ${i + 1}:\n${contexts[i]}\n\n`
  }

  prompt += `Question: ${query}\n
  """\n`

  return prompt;
}

exports.getGptTurboSingeShotResponse = async (prompt, openAIKey) => {
  /* 
   * NO NEED TO SPECIFY MAX TOKENS
   * role: assistant, system, user
   */

  const request = {
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'post',
      headers: {
          'Authorization': `Bearer ${openAIKey}`,
          
      },
      data: {
          model: "gpt-3.5-turbo",
          temperature: 0,
          messages:[
              {
                  role: 'system',
                  content: 'You are a helpful assistant.',

              },
              {
                  role: 'user',
                  content: prompt
              }
          ]
      }
  }

  console.log(request);

  let response;
  let answer;

  try {
      response = await axios(request);
      const message = response.data.choices[0].message.content;
      if (message === `I don't know.`) answer = "I don't know";
      else {
          console.log('response.data', response.data);
          console.log(response.data.choices[0].message.content);
          let responseJson = message.replaceAll("\n", "");
          
          try {
            const loc = responseJson.lastIndexOf('}');
            if (loc > -1) responseJson = responseJson.substring(0, loc + 1);
            console.log('responseJson', responseJson);
            const answerObj = JSON.parse(responseJson);
            answer = answerObj.answer;
          } catch(error) {
            answer = responseJson;
          }
      }
  } catch (e) {
      console.error(e.response && e.response.data ? e.response.data : e);
      return ("Something went wrong.");
  }

  return answer;
}

exports.getDavinciResponse = async (prompt, openAIKey) => {
  const request = {
      url: 'https://api.openai.com/v1/completions',
      method: 'post',
      headers: {
          'Authorization': `Bearer ${openAIKey}`,
          
      },
      data: {
          model: "text-davinci-003",
          prompt,
          max_tokens: 1000,
          temperature: 0,
      }

  }

  console.log('request', request);

  let response;

  try {
      response = await axios(request);
      //console.log(response.data);
  } catch (e) {
      console.error(e);
      console.error(e.response.data);
      return 'AI Error: Please try again.';
  }

  let answer = JSON.parse(response.data.choices[0].text.replaceAll("\n", ""));

  return answer.answer;
}
