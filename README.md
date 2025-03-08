# Screen Answerer

Screen Answerer is a powerful tool designed to help users identify and answer quiz questions in real-time. Powered by Google's Gemini AI, this application monitors your screen for quiz questions and provides instant answers.

## Features

- **Real-time Screen Monitoring**: Automatically detects quiz questions on your screen
- **Instant Answers**: Provides concise, accurate answers to detected questions
- **Customizable Settings**: Choose between different Gemini AI models for optimal performance
- **Dark/Light Theme**: Select your preferred visual theme
- **Local Storage**: Your API key is stored locally in your browser for security
- **Responsive Design**: Works on various screen sizes

## Installation

### Prerequisites

- Node.js (v14 or higher)
- npm (v6 or higher)
- Google Gemini API key

### Setup

1. Clone the repository or download the source code

2. Install dependencies:
   ```
   npm install
   ```

3. Start the server:
   ```
   npm start
   ```

4. Open your browser and navigate to `http://localhost:3000`

5. In the Screen Answerer app, click the ⚙️ settings icon

## Usage

1. Configure your API key in the settings
2. Click "Start Monitoring" to begin screen capture
3. When a quiz question is detected on your screen, the app will display the answer
4. View your answer history in the results section
5. Click "Stop Monitoring" when finished

## Technology Stack

- **Frontend**: HTML, CSS, JavaScript
- **Backend**: Node.js, Express
- **AI**: Google Generative AI (Gemini)
- **Dependencies**:
  - @google/generative-ai: For AI processing
  - express: Web server framework
  - multer: For handling file uploads
  - cors: For cross-origin resource sharing
  - helmet: For enhanced security
  - marked: For Markdown parsing

## Security Notes

- Your API key is stored locally in your browser and never sent to our servers
- Using this app will count against your Gemini API quota
- Keep your API key private

## License

This project is open source and available under the MIT License.

## Support

For issues or questions, please open an issue in the repository or contact the maintainers.